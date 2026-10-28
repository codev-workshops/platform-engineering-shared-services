# Deployment Runbook

Step-by-step procedure for deploying the shared platform. It mirrors the five phases of [`scripts/deploy-dev.sh`](../../scripts/deploy-dev.sh) so you can run them one at a time, stop between phases, and deploy staging/prod (the script is hard-wired to `WorkshopPlatformDev` / `workshop-dev`).

> **Fast path (dev only):** `./scripts/deploy-dev.sh` runs all five phases end-to-end (~20 min on a fresh cluster). Use this runbook when you need control, are deploying staging/prod, or the script failed part-way.

## Environment matrix

From [`cdk/bin/cdk.ts`](../../cdk/bin/cdk.ts) (node group settings are passed to [`cdk/lib/constructs/eks-cluster.ts`](../../cdk/lib/constructs/eks-cluster.ts)):

| | Dev | Staging | Prod |
|---|---|---|---|
| CDK stack | `WorkshopPlatformDev` | `WorkshopPlatformStaging` | `WorkshopPlatformProd` |
| EKS cluster | `workshop-dev` | `workshop-staging` | `workshop-prod` |
| AZs (`maxAzs`) | 2 | 2 | 3 |
| NAT gateways | 1 | 1 | 2 |
| Node instance type | `t3.medium` | `t3.medium` | `t3.large` |
| Nodes min / desired / max | 1 / 2 / 3 | 2 / 3 / 5 | 3 / 3 / 10 |
| App namespaces | `decomposition-dev`, `decomposition-staging` | `decomposition-staging` | `decomposition-prod` |
| Kubernetes version | 1.31 | 1.31 | 1.31 |

All stacks create the same six ECR repos (`workshop/web-frontend`, `workshop/api-gateway`, `workshop/order-service`, `workshop/inventory-service`, `workshop/customer-service`, `workshop/product-service`) and use `RemovalPolicy.DESTROY` on everything.

Set these once per shell and the rest of the runbook is copy-paste:

```bash
export ENV=dev                       # dev | staging | prod
export STACK=WorkshopPlatformDev     # WorkshopPlatformDev | WorkshopPlatformStaging | WorkshopPlatformProd
export CLUSTER_NAME=workshop-$ENV
export AWS_REGION=us-east-1
```

## 0. Prerequisites

| Tool | Requirement | Check |
|------|-------------|-------|
| AWS CLI | Credentials for the target account with CloudFormation/EKS/EC2/IAM/ECR/Route 53 rights | `aws --version` |
| Node.js | >= 18 (with npm) | `node --version` |
| Helm | >= 3.x | `helm version --short` |
| kubectl | Compatible with EKS 1.31 (1.30–1.32) | `kubectl version --client` |

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
# export AWS_SESSION_TOKEN=...   # if using temporary credentials
```

## 1. Pre-deployment checks

Do not skip these — each one catches a failure that otherwise shows up 15 minutes into a CloudFormation deploy.

```bash
# 1. Right account / identity?
aws sts get-caller-identity
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 2. Helm repos present? (deploy-dev.sh adds these four)
helm repo list
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add jetstack https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# 3. CDK compiles and lists the expected stacks
cd cdk
npm install
npm run build
npx cdk ls            # expect WorkshopPlatformDev, WorkshopPlatformStaging, WorkshopPlatformProd

# 4. Review the infra change set
npx cdk diff "$STACK"
cd ..
```

**Stop and review** if `cdk diff` shows `[-]` (delete) or `requires replacement` on `EksCluster`, `Networking/Vpc`, or any `EcrRepositories/*` resource — with `RemovalPolicy.DESTROY` a replacement deletes the old resource and its data (ECR images are auto-deleted via `emptyOnDelete`).

## 2. Phase 1 — Bootstrap CDK (one-time per account/region)

```bash
cd cdk
npx cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/${AWS_REGION}"
cd ..
```

Idempotent; safe to re-run. Creates the `CDKToolkit` stack.

## 3. Phase 2 — Deploy the CDK stack (VPC, EKS, ECR, namespaces)

```bash
cd cdk
npx cdk deploy "$STACK" --require-approval never   # deploy-dev.sh uses this flag
# For prod, drop --require-approval never so IAM/security-group changes are shown for approval:
# npx cdk deploy WorkshopPlatformProd
cd ..
```

Expect 15–20 minutes for a new cluster. If the deploy fails, CloudFormation rolls back automatically — see [rollback-runbook.md § CDK infrastructure](rollback-runbook.md#2-cdk-infrastructure-cloudformation).

Get the stack outputs (`ClusterName`, `ClusterEndpoint`, `ClusterArn`, `KubectlConfigCommand`, and `HostedZoneId` if a domain is set):

```bash
aws cloudformation describe-stacks --stack-name "$STACK" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs' --output table
```

> The summary at the end of `deploy-dev.sh` prints `npx cdk context --json` and suggests `npx cdk outputs`, which is not a CDK CLI command. Use the `describe-stacks` command above instead.

## 4. Phase 3 — Configure kubectl

```bash
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" --alias "$CLUSTER_NAME"
# dev literal: aws eks update-kubeconfig --name workshop-dev --region us-east-1 --alias workshop-dev

kubectl config current-context    # must be $CLUSTER_NAME before continuing
kubectl cluster-info
kubectl get nodes
```

Nodes should be `Ready` and count should match the "desired" column above. The cluster's admin role is `workshop-<env>-admin` (created in `eks-cluster.ts`); if `kubectl` returns `Unauthorized`, your identity is not the stack creator — assume that role or add an access entry.

## 5. Phase 4 — Install shared Helm releases (in this order)

Order matters: ingress-nginx first (cert-manager's HTTP-01 solver uses the `nginx` class), then cert-manager + ClusterIssuers, then monitoring, then ArgoCD.

```bash
# 4a. ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -f helm-releases/ingress-nginx/values.yaml \
  -n ingress-nginx --create-namespace --wait --timeout 5m

# 4b. cert-manager (installCRDs: true) + ClusterIssuers
helm upgrade --install cert-manager jetstack/cert-manager \
  -f helm-releases/cert-manager/values.yaml \
  -n cert-manager --create-namespace --wait --timeout 5m

kubectl apply -f helm-releases/cert-manager/cluster-issuer.yaml   # letsencrypt-prod + letsencrypt-staging

# 4c. kube-prometheus-stack (release name "prometheus"; Grafana values layered on top)
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -f helm-releases/monitoring/prometheus/values.yaml \
  -f helm-releases/monitoring/grafana/values.yaml \
  -n monitoring --create-namespace --wait --timeout 5m

# 4d. Argo CD
helm upgrade --install argocd argo/argo-cd \
  -f helm-releases/argocd/values.yaml \
  -n argocd --create-namespace --wait --timeout 5m
```

After each release: `helm status <release> -n <namespace>` should show `STATUS: deployed`.

> **Chart versions are not pinned** in `deploy-dev.sh` — every run installs the latest chart. To make a deploy reproducible (and rollbacks meaningful), record versions with `helm list -A` afterwards, or add `--version <x.y.z>` to each command.

### ExternalDNS (optional, manual)

`helm-releases/external-dns/values.yaml` exists but `deploy-dev.sh` does **not** install it. Before installing, replace the placeholders `domainFilters: [example.com]` and `eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/external-dns` (no such IAM role is created by the CDK stack — create an IRSA role with Route 53 permissions first).

```bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm upgrade --install external-dns external-dns/external-dns \
  -f helm-releases/external-dns/values.yaml \
  -n external-dns --create-namespace --wait --timeout 5m
```

## 6. Phase 5 — Apply network policies to app namespaces

`k8s/network-policies/default-deny.yaml` contains four policies: `default-deny-all`, `allow-dns`, `allow-ingress-controller`, `allow-prometheus-scrape`.

```bash
# dev stack (what deploy-dev.sh does)
for NS in decomposition-dev decomposition-staging; do
  kubectl apply -f k8s/network-policies/default-deny.yaml -n "$NS"
done

# staging stack:  NS=decomposition-staging
# prod stack:     NS=decomposition-prod
```

> `deploy-dev.sh` silences errors here (`2>/dev/null || echo "...skipping"`), so a missing namespace is easy to miss. Run it manually or confirm with the verification step below.

**Before applying to a namespace with running workloads:** `default-deny-all` blocks all pod-to-pod and egress traffic except DNS, ingress from `ingress-nginx`, and scrapes from `monitoring` on 8080/9090. App teams must have their own allow policies (see [`docs/onboarding.md`](../onboarding.md)) in place first.

## 7. Post-deployment verification

```bash
# Nodes
kubectl get nodes -o wide

# All pods Running/Completed (no CrashLoopBackOff / Pending)
kubectl get pods -A
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded

# Helm releases deployed
helm list -A

# ClusterIssuers Ready=True
kubectl get clusterissuer
kubectl wait --for=condition=Ready clusterissuer/letsencrypt-staging clusterissuer/letsencrypt-prod --timeout=2m

# ingress-nginx NLB has an external hostname (can take 2-3 min)
kubectl -n ingress-nginx get svc ingress-nginx-controller
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'; echo

# Monitoring PVCs bound (Prometheus 20Gi, Grafana 5Gi)
kubectl -n monitoring get pvc

# Network policies present in each app namespace (expect 4)
kubectl get networkpolicy -n decomposition-dev
kubectl get networkpolicy -n decomposition-staging

# ResourceQuota / LimitRange from the CDK K8sNamespaces construct
kubectl get resourcequota,limitrange -n decomposition-dev

# Argo CD initial admin password
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8080:80   # then open http://localhost:8080 (server.insecure: true)
```

Deployment is done when: all nodes `Ready`, no pods outside `Running`/`Completed`, 4 releases `deployed`, both ClusterIssuers `Ready=True`, the NLB has a hostname, monitoring PVCs are `Bound`, and each app namespace has 4 NetworkPolicies.

## 8. Known issues to watch for

These were found by reading the repo's values against the current upstream charts. Check them during your first deploy of an environment.

| Issue | Symptom | What to do |
|-------|---------|------------|
| ServiceMonitor CRD ordering | `ingress-nginx` (`controller.metrics.serviceMonitor.enabled: true`) and `cert-manager` (`prometheus.servicemonitor.enabled: true`) are installed **before** kube-prometheus-stack, which installs the `monitoring.coreos.com` CRDs. On a fresh cluster the install can fail with `no matches for kind "ServiceMonitor" in version "monitoring.coreos.com/v1"`. | Install the `prometheus` release first, then re-run 4a/4b; or pass `--set controller.metrics.serviceMonitor.enabled=false` / `--set prometheus.servicemonitor.enabled=false` on the first install and re-enable later. |
| No EBS CSI driver / default StorageClass | Prometheus and Grafana PVCs stay `Pending` and the `prometheus` release times out on `--wait`. The CDK stack does not install the `aws-ebs-csi-driver` add-on. | `kubectl get storageclass`; `kubectl -n monitoring describe pvc`. Install the EBS CSI driver add-on (with an IAM role) and make sure a default StorageClass exists. Fix forward — see [incident-response.md § a](incident-response.md#a-pods-not-starting). |
| ClusterIssuer placeholder email | `email: admin@example.com` in `cluster-issuer.yaml`; Let's Encrypt rejects `example.com` contacts, so ClusterIssuers may not become Ready. | Replace with a real team mailbox, then `kubectl apply -f helm-releases/cert-manager/cluster-issuer.yaml`. |
| Argo CD ingress host ignored | `helm-releases/argocd/values.yaml` sets `server.ingress.hosts: [argocd.workshop.local]`, but current `argo/argo-cd` charts read `server.ingress.hostname` / `global.domain`; the rendered Ingress host is `argocd.example.com`. | Use port-forward (above), or set `global.domain` / `server.ingress.hostname` in the values file. |
| `kubectl top` unavailable | `error: Metrics API not available` — metrics-server is not installed by this repo. | Use Prometheus/Grafana or `kubectl describe nodes` (see [incident-response.md § h](incident-response.md#h-node-capacity)). |
