# Rollback Runbook

How to back out a bad change, one section per platform layer. Each section starts with **decision criteria** — rollback is not always the right call. Use the [decision matrix](#decision-matrix) first if you are unsure which layer is at fault, and [incident-response.md](incident-response.md) to diagnose.

```bash
export ENV=dev STACK=WorkshopPlatformDev CLUSTER_NAME=workshop-dev AWS_REGION=us-east-1
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" --alias "$CLUSTER_NAME"
kubectl config current-context   # confirm you are on the right cluster before rolling anything back
```

## Decision matrix

| Symptom | Affected layer | Action |
|---------|----------------|--------|
| Shared-service pods fail readiness / CrashLoop right after `helm upgrade` | Helm release | **Rollback** — `helm rollback` ([§1](#1-helm-releases)) |
| Ingress returning 5xx for all hosts right after an ingress-nginx upgrade | Helm release (`ingress-nginx`) | **Rollback** ([§1](#1-helm-releases)) |
| Certificates stop issuing right after a cert-manager upgrade | Helm release (`cert-manager`) | **Rollback** ([§1](#1-helm-releases)) |
| Grafana/Prometheus broken right after a monitoring upgrade | Helm release (`prometheus`) | **Rollback** ([§1](#1-helm-releases)) |
| Helm release stuck in `pending-install` / `pending-upgrade` | Helm release | **Fix forward** — clear the stuck state, then re-run the upgrade ([§1.4](#14-stuck-pending-release--fix-forward-do-not-rollback)) |
| PVCs `Pending`, pods `Pending` on scheduling/quota | Helm values / cluster capacity | **Fix forward** — rollback will not create storage or capacity ([incident-response § a, h](incident-response.md#a-pods-not-starting)) |
| `cdk deploy` failed mid-way | CDK / CloudFormation | **Automatic** — CloudFormation rolls back; verify state ([§2.1](#21-failed-deploy--automatic-rollback)) |
| `cdk deploy` succeeded but nodes/VPC/IAM misbehave | CDK / CloudFormation | **Rollback** — redeploy previous commit ([§2.2](#22-successful-deploy-that-made-things-worse)) |
| App traffic blocked right after applying/changing a NetworkPolicy | Network policies | **Rollback** — delete or re-apply from git ([§3](#3-network-policies)) |
| App broken after an ArgoCD sync of a new revision | ArgoCD-managed app | **Rollback** — `git revert` (preferred) or `argocd app rollback` ([§4](#4-argocd-managed-applications)) |
| ArgoCD app `OutOfSync` / `ComparisonError` but running pods healthy | ArgoCD config / app repo | **Fix forward** — fix the manifest/values ([incident-response § e](incident-response.md#e-argocd-sync-failures)) |
| Dev cluster unrecoverable / state corrupted | Everything (dev only) | **Last resort** — `scripts/teardown-dev.sh` + redeploy ([§5](#5-last-resort-teardown-and-redeploy-dev-only)) |

Rule of thumb: **roll back when the last change is clearly the cause and the previous state was healthy; fix forward when the previous state would fail the same way** (missing storage, quota, capacity, a stuck release lock, bad credentials).

---

## 1. Helm releases

| Release | Namespace | Values |
|---------|-----------|--------|
| `argocd` | `argocd` | `helm-releases/argocd/values.yaml` |
| `prometheus` | `monitoring` | `helm-releases/monitoring/prometheus/values.yaml` + `helm-releases/monitoring/grafana/values.yaml` |
| `cert-manager` | `cert-manager` | `helm-releases/cert-manager/values.yaml` |
| `ingress-nginx` | `ingress-nginx` | `helm-releases/ingress-nginx/values.yaml` |

### 1.1 Decision criteria

Roll back when **all** of these hold:
- The problem started with a `helm upgrade` (or a `deploy-dev.sh` run, which upgrades every release to the **latest unpinned** chart).
- Pods of that release fail readiness, crash-loop, or the service it provides is degraded (5xx from ingress, certs not issuing, Grafana/Prometheus down, ArgoCD UI/API down).
- `helm history` shows a previous revision with `STATUS: superseded` that was healthy.

Do **not** roll back when the release is stuck `pending-*` (see 1.4) or pods are `Pending` for storage/capacity reasons — the previous revision has the same problem.

### 1.2 Inspect history

```bash
helm history argocd        -n argocd
helm history prometheus    -n monitoring
helm history cert-manager  -n cert-manager
helm history ingress-nginx -n ingress-nginx

# Compare what changed between revisions (values and chart version)
helm get values ingress-nginx -n ingress-nginx --revision <REV>
helm history ingress-nginx -n ingress-nginx -o yaml | grep -E 'revision|chart|status'
```

### 1.3 Roll back

```bash
# helm rollback <release> <revision> -n <namespace> --wait --timeout 5m
helm rollback argocd        <REV> -n argocd        --wait --timeout 5m
helm rollback prometheus    <REV> -n monitoring    --wait --timeout 5m
helm rollback cert-manager  <REV> -n cert-manager  --wait --timeout 5m
helm rollback ingress-nginx <REV> -n ingress-nginx --wait --timeout 5m
```

Omitting `<REV>` rolls back to the immediately previous revision. Verify:

```bash
helm status <release> -n <namespace>
kubectl get pods -n <namespace>
```

Caveats:
- **CRDs are not rolled back.** `cert-manager` (`installCRDs: true`) and `kube-prometheus-stack` CRDs stay at the newer version. Usually fine (CRDs are backward compatible); if not, fix forward.
- **cert-manager order:** after rolling back cert-manager, re-check `kubectl get clusterissuer` — re-apply `helm-releases/cert-manager/cluster-issuer.yaml` if they are missing.
- **Pin the version afterwards.** The next `deploy-dev.sh` run will upgrade to latest again. Add `--version <x.y.z>` (taken from `helm history`) to the script/commands, or the incident will recur.

### 1.4 Stuck pending release — fix forward, do not rollback

```bash
helm history <release> -n <namespace>   # last revision shows pending-install / pending-upgrade
helm status  <release> -n <namespace>
```

A stuck release usually means `--wait --timeout 5m` expired (often Pending PVCs or image pulls) or the client was interrupted. Rolling back just repeats the wait. Instead:

1. Fix the underlying cause (see [incident-response.md](incident-response.md)).
2. If the newest revision is `pending-upgrade`, run `helm rollback <release> <last-deployed-rev> -n <namespace>` **only** to release the lock, then re-run the `helm upgrade --install` command from [deployment-runbook.md § Phase 4](deployment-runbook.md#5-phase-4--install-shared-helm-releases-in-this-order).
3. If it is `pending-install` (first install), `helm uninstall <release> -n <namespace>` and re-install.

---

## 2. CDK infrastructure (CloudFormation)

Covers everything in `WorkshopPlatformDev` / `WorkshopPlatformStaging` / `WorkshopPlatformProd`: VPC (`Networking`), EKS cluster + node group (`EksCluster`), ECR repos, Route 53 zone, and namespaces/quotas/limit ranges (`K8sNamespaces`).

### 2.1 Failed deploy — automatic rollback

If `npx cdk deploy` fails, CloudFormation automatically rolls the stack back to its last good state (unless `--no-rollback` was passed). Confirm:

```bash
aws cloudformation describe-stacks --stack-name "$STACK" --region "$AWS_REGION" \
  --query 'Stacks[0].StackStatus' --output text
# expect UPDATE_ROLLBACK_COMPLETE (existing stack) — the stack is usable again

aws cloudformation describe-stack-events --stack-name "$STACK" --region "$AWS_REGION" \
  --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" \
  --output table
```

| Status | Meaning | Action |
|--------|---------|--------|
| `UPDATE_ROLLBACK_COMPLETE` | Rolled back cleanly | Fix the code, `npx cdk diff`, redeploy |
| `UPDATE_ROLLBACK_FAILED` | Rollback itself failed (often a resource changed outside CFN) | `aws cloudformation continue-update-rollback --stack-name "$STACK" --region "$AWS_REGION"` (add `--resources-to-skip <LogicalId>` if needed) |
| `ROLLBACK_COMPLETE` | First-ever create failed | Stack can't be updated; `npx cdk destroy "$STACK"` then deploy again |

### 2.2 Successful deploy that made things worse

Decision criteria: the deploy completed but nodes, networking, IAM, ECR, or namespace quotas are now wrong, and the previous commit was healthy.

```bash
git log --oneline -- cdk/                 # find the last good commit
git switch -c rollback/cdk-<short-desc> <GOOD_SHA>   # or: git revert <BAD_SHA>
cd cdk
npm install
npx cdk diff "$STACK"                     # read this carefully
npx cdk deploy "$STACK"                   # omit --require-approval never so you see security changes
cd ..
```

**Read the diff before deploying.** Because every resource uses `RemovalPolicy.DESTROY`, any line showing `requires replacement` on the cluster (e.g. changing `clusterName`), the VPC, or an ECR repo means CloudFormation will **delete** the existing resource — including all workloads or images in it. If the rollback itself would replace the cluster, stop and escalate instead.

Prefer `git revert` + PR over checking out an old SHA so `main` matches what's deployed.

---

## 3. Network policies

Base policies live in `k8s/network-policies/default-deny.yaml` (`default-deny-all`, `allow-dns`, `allow-ingress-controller`, `allow-prometheus-scrape`), applied to `decomposition-dev`, `decomposition-staging` (and `decomposition-prod` on the prod stack). App-specific policies live in the app IaC repo.

Decision criteria: traffic broke immediately after a policy was applied or edited, and pods themselves are healthy (`kubectl get pods` Running/Ready).

```bash
NS=decomposition-dev
kubectl get networkpolicy -n "$NS"
kubectl describe networkpolicy <name> -n "$NS"

# Remove an offending app-specific policy
kubectl delete networkpolicy <name> -n "$NS"
# or, if it came from a file:
kubectl delete -f <path/to/offending-policy.yaml> -n "$NS"

# Restore the base policies exactly as they are in git
git checkout origin/main -- k8s/network-policies/default-deny.yaml
kubectl apply -f k8s/network-policies/default-deny.yaml -n "$NS"
```

Emergency only (opens the namespace completely — remove as soon as service is restored):

```bash
kubectl delete -f k8s/network-policies/default-deny.yaml -n "$NS"   # removes all 4 base policies
```

---

## 4. ArgoCD-managed applications

App `Application` manifests live in the app IaC repo (see [`docs/onboarding.md`](../onboarding.md)) and typically use `syncPolicy.automated` with `prune: true, selfHeal: true`.

Decision criteria: the app degraded right after ArgoCD synced a new revision.

### Preferred: git revert

```bash
# in the app IaC repo
git revert <BAD_SHA>
git push            # via PR per team process; ArgoCD auto-syncs the reverted state
argocd app get <app-name>
```

### Fast: `argocd app rollback`

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:80 &
argocd login localhost:8080 --username admin --plaintext \
  --password "$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"

argocd app history <app-name>
# Rollback is refused while automated sync is on — disable it first, or selfHeal will undo the rollback
argocd app set <app-name> --sync-policy none
argocd app rollback <app-name> <HISTORY_ID>
argocd app wait <app-name> --health --timeout 300
```

Then fix the app repo and re-enable auto-sync (`argocd app set <app-name> --sync-policy automated --auto-prune --self-heal`). Leaving auto-sync off means the cluster silently drifts from git.

---

## 5. Last resort: teardown and redeploy (dev only)

> **WARNING — destroys all data.** `scripts/teardown-dev.sh` uninstalls `argocd`, `prometheus`, `cert-manager`, `ingress-nginx`, then runs `npx cdk destroy WorkshopPlatformDev --force`. Every resource uses `RemovalPolicy.DESTROY`: the EKS cluster and **all workloads**, the VPC, the Route 53 zone (if created), and **all ECR repositories including their images** (`emptyOnDelete: true`) are permanently deleted. Prometheus/Grafana data and ArgoCD state are lost.
>
> **Dev only.** The script is hard-coded to `WorkshopPlatformDev` / `workshop-dev`. Never adapt it for staging or prod.

Use only when the dev environment is unrecoverable and rebuilding is faster than repairing.

```bash
./scripts/teardown-dev.sh        # prompts: type 'destroy' to confirm
./scripts/deploy-dev.sh          # rebuild (~20 min)
```

After teardown, check for leftovers that live outside CloudFormation (EBS volumes from Prometheus/Grafana PVCs, the NLB if `ingress-nginx` uninstall failed):

```bash
aws ec2 describe-volumes --region us-east-1 \
  --filters Name=tag:kubernetes.io/cluster/workshop-dev,Values=owned \
  --query 'Volumes[].[VolumeId,State,Size]' --output table
aws elbv2 describe-load-balancers --region us-east-1 --query 'LoadBalancers[].LoadBalancerName'
```

The `CDKToolkit` bootstrap stack is preserved. Delete it only if you're leaving the account entirely; the `npx cdk destroy CDKToolkit --force` hint printed by the script won't work because `CDKToolkit` is not a stack in this CDK app — empty its staging S3 bucket and run `aws cloudformation delete-stack --stack-name CDKToolkit --region us-east-1` instead.
