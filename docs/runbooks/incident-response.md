# Incident Response — Troubleshooting Decision Tree

Start at the symptom, run the **detection** commands, match the **likely cause**, apply the **remediation**. Each section ends with when to stop debugging and go to [rollback-runbook.md](rollback-runbook.md). For severity and who to page, see the [escalation template](monitoring-guide.md#escalation-procedure-template).

```bash
export CLUSTER_NAME=workshop-dev AWS_REGION=us-east-1 NS=decomposition-dev
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" --alias "$CLUSTER_NAME"
```

```
What's the symptom?
├── Pods Pending / CrashLoopBackOff / ImagePullBackOff ........ (a) Pods not starting
├── Pod-to-pod or egress calls time out .......................... (b) Traffic blocked
├── Browser TLS error / cert not issued ......................... (c) TLS failures
├── HTTP 502 / 503 / 404 from the ingress hostname ............... (d) Ingress 502/404
├── ArgoCD app OutOfSync / Degraded / sync error ................. (e) ArgoCD sync failures
├── Hostname does not resolve ..................................... (f) DNS not resolving
├── No data in Grafana / target missing in Prometheus ............ (g) Metrics missing
└── "Insufficient cpu/memory", "Too many pods", nodes NotReady .. (h) Node capacity
```

First 60 seconds, any incident:

```bash
kubectl get nodes
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
helm list -A                                        # any release not "deployed"?
kubectl get events -A --sort-by=.lastTimestamp | tail -30
```

---

## (a) Pods not starting

**Detection**
```bash
kubectl get pods -n "$NS"
kubectl describe pod <pod> -n "$NS"                 # read the Events section at the bottom
kubectl logs <pod> -n "$NS" --previous              # for CrashLoopBackOff
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20

# Quota / limit exhaustion (created by cdk/lib/constructs/k8s-namespaces.ts)
kubectl describe resourcequota "$NS-quota" -n "$NS"
kubectl describe limitrange "$NS-limits" -n "$NS"
kubectl get replicaset -n "$NS"                     # DESIRED > CURRENT with no pods = quota rejection
kubectl describe replicaset <rs> -n "$NS" | grep -i forbidden
```

**Likely causes**

| Event / message | Cause |
|-----------------|-------|
| `exceeded quota: <ns>-quota` (pods never created; seen on the ReplicaSet) | Namespace quota hit. Defaults: `requests.cpu: 2`, `requests.memory: 4Gi`, `limits.cpu: 4`, `limits.memory: 8Gi`, `pods: 20` |
| Pods get unexpected requests/limits | LimitRange `<ns>-limits` injects `100m/128Mi` requests and `500m/256Mi` limits when a container doesn't set them — OOMKilled at 256Mi is common |
| `OOMKilled` in `describe pod` | Memory limit too low (often the LimitRange default) |
| `0/N nodes are available: Insufficient cpu/memory` or `Too many pods` | Cluster capacity — go to (h) |
| `pod has unbound immediate PersistentVolumeClaims` | No provisioner/default StorageClass — common for `prometheus`/`grafana` in `monitoring` |
| `ImagePullBackOff` / `ErrImagePull` | Wrong ECR tag, image not pushed, or node role lacks ECR pull |
| CrashLoopBackOff with app error in logs | Application bug/config |

**Remediation**
- Quota: reduce replicas or requests, or raise the namespace quota by setting `cpuRequestLimit` / `memoryRequestLimit` / `cpuLimit` / `memoryLimit` / `maxPods` on the namespace entry in `cdk/bin/cdk.ts`, then `cd cdk && npx cdk diff <Stack> && npx cdk deploy <Stack>`.
- OOMKilled: set explicit `resources` in the app chart instead of relying on LimitRange defaults.
- PVC Pending:
  ```bash
  kubectl get storageclass                         # is any marked (default)?
  kubectl -n monitoring get pvc
  kubectl -n monitoring describe pvc <pvc>
  aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name aws-ebs-csi-driver --region "$AWS_REGION"
  ```
  The CDK stack doesn't install the EBS CSI driver. Install the `aws-ebs-csi-driver` EKS add-on with an IAM role that has `AmazonEBSCSIDriverPolicy`, ensure a default StorageClass (e.g. `gp3` with `ebs.csi.aws.com`), then re-run the Helm install. Long-term fix: add the add-on to `cdk/lib/constructs/eks-cluster.ts`.
- ImagePull: `aws ecr describe-images --repository-name workshop/<service> --region us-east-1` and fix the tag.

**Escalate to rollback** if pods started failing right after a Helm upgrade or ArgoCD sync and the previous revision was healthy → [rollback § 1](rollback-runbook.md#1-helm-releases) / [§ 4](rollback-runbook.md#4-argocd-managed-applications). Quota, storage, and capacity issues are **fix-forward**.

---

## (b) Traffic blocked

**Detection**
```bash
kubectl get networkpolicy -n "$NS"
# Expect: default-deny-all, allow-dns, allow-ingress-controller, allow-prometheus-scrape (+ app-specific)
kubectl describe networkpolicy -n "$NS"

# Test from inside the namespace
kubectl run -n "$NS" nettest --rm -it --image=busybox:1.36 --restart=Never -- sh -c \
  'nslookup kubernetes.default; wget -qO- -T 3 http://<service>.<ns>.svc.cluster.local:<port> || echo BLOCKED'

# Is NetworkPolicy actually enforced? (Amazon VPC CNI needs the network policy agent enabled)
kubectl -n kube-system get ds aws-node -o jsonpath='{.spec.template.spec.containers[*].name}'; echo
```

**Likely causes**
- `default-deny-all` is applied (policyTypes Ingress **and** Egress, all pods). After it, only these are allowed:
  - `allow-dns`: egress UDP/TCP 53 to anywhere
  - `allow-ingress-controller`: ingress from namespace `ingress-nginx`
  - `allow-prometheus-scrape`: ingress from namespace `monitoring` on TCP 8080 and 9090 only
- So **pod-to-pod inside the namespace, calls to databases, and all external egress are blocked** until the app team adds its own allow policy (example in [`docs/onboarding.md`](../onboarding.md)).
- One of the three allow policies is missing (e.g. someone applied only `default-deny-all`, or `deploy-dev.sh` skipped the namespace silently).
- The reverse case: policies exist but **nothing is blocked** — if `aws-node` has no `aws-network-policy-agent` container, the VPC CNI is not enforcing NetworkPolicies at all.

**Remediation**
```bash
# Re-apply the base set (restores any missing allow policy)
kubectl apply -f k8s/network-policies/default-deny.yaml -n "$NS"

# Add an app-specific allow, e.g. api-gateway -> order-service on 8080
cat <<'YAML' | kubectl apply -n "$NS" -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-gateway-to-order-service
spec:
  podSelector:
    matchLabels: { app: order-service }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: api-gateway }
      ports:
        - { protocol: TCP, port: 8080 }
YAML
```
Remember egress must also be allowed on the caller side (`default-deny-all` covers Egress). Commit permanent policies to the app IaC repo.

**Escalate to rollback** if traffic broke immediately after a policy change → [rollback § 3](rollback-runbook.md#3-network-policies).

---

## (c) TLS failures

**Detection**
```bash
kubectl get clusterissuer                         # letsencrypt-prod, letsencrypt-staging: READY=True?
kubectl describe clusterissuer letsencrypt-prod
kubectl get certificate,certificaterequest,order,challenge -A
kubectl describe certificate <name> -n <ns>
kubectl -n cert-manager logs deploy/cert-manager --tail=100
kubectl -n cert-manager logs deploy/cert-manager-webhook --tail=50
```

**Likely causes**
- ClusterIssuer not Ready: `email: admin@example.com` placeholder in `helm-releases/cert-manager/cluster-issuer.yaml` is rejected by Let's Encrypt.
- Using `letsencrypt-staging` (the default in `argocd/values.yaml` and the onboarding Ingress example) — browsers show "untrusted issuer". Expected; switch to `letsencrypt-prod` when ready.
- HTTP-01 challenge fails: hostname isn't publicly resolvable to the ingress-nginx NLB (e.g. `*.workshop.local` hosts can never pass), or the solver pod is blocked by NetworkPolicy in an app namespace.
- Ingress has the `cert-manager.io/cluster-issuer` annotation but no `spec.tls` block → no Certificate is created.
- Let's Encrypt rate limits (prod issuer) after repeated retries.

**Remediation**
- Fix the email, `kubectl apply -f helm-releases/cert-manager/cluster-issuer.yaml`, wait for `READY=True`.
- Make sure the host resolves to `kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'` (see (f)).
- Add `spec.tls: [{hosts: [<host>], secretName: <name>-tls}]` to the Ingress.
- Force re-issue: `kubectl delete certificaterequest -n <ns> <name>` (cert-manager recreates it).

**Escalate to rollback** if issuance broke right after a `cert-manager` upgrade → [rollback § 1](rollback-runbook.md#1-helm-releases).

---

## (d) Ingress 502 / 404

**Detection**
```bash
kubectl get ingress -A
kubectl describe ingress <name> -n <ns>           # check host, class, backend service/port
kubectl -n ingress-nginx get pods,svc
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=200 | grep -E ' 50[234] | 404 |error'
kubectl get endpoints <service> -n <ns>           # empty = no ready pods behind the Service
```

**Likely causes**

| Response | Cause |
|----------|-------|
| 404 from nginx (default backend) | No Ingress matches the Host header, or `ingressClassName` isn't `nginx` |
| 502 Bad Gateway | Backend pods not Ready / wrong `targetPort`, or `allow-ingress-controller` NetworkPolicy missing in the app namespace |
| 503 Service Unavailable | Service has no endpoints (selector mismatch or 0 ready pods) |
| Connection refused / no response | NLB not provisioned — `EXTERNAL-IP` `<pending>` on `ingress-nginx-controller` |

**Remediation**
- Fix `host` / `ingressClassName: nginx` / service name+port in the app chart.
- Fix Service selector or readiness probe; confirm `kubectl get endpoints` lists pod IPs.
- `kubectl apply -f k8s/network-policies/default-deny.yaml -n <ns>` to restore `allow-ingress-controller`.
- NLB pending: `kubectl -n ingress-nginx describe svc ingress-nginx-controller` events; public subnets must carry `kubernetes.io/role/elb=1` (set in `cdk/lib/constructs/networking.ts`).

**Escalate to rollback** if every host started failing right after an `ingress-nginx` upgrade → [rollback § 1](rollback-runbook.md#1-helm-releases).

---

## (e) ArgoCD sync failures

**Detection**
```bash
kubectl get applications -n argocd
kubectl -n argocd port-forward svc/argocd-server 8080:80 &
argocd login localhost:8080 --username admin --plaintext \
  --password "$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
argocd app get <app-name>
argocd app diff <app-name>
kubectl -n argocd logs deploy/argocd-repo-server --tail=100
kubectl -n argocd logs statefulset/argocd-application-controller --tail=100
```

**Likely causes**
- `ComparisonError` / `repository not found`: wrong `repoURL`, private repo without credentials registered in ArgoCD.
- `Unable to generate manifests`: bad chart `path`, missing/incorrect `helm.valueFiles` path (onboarding example uses `../../environments/dev/values.yaml` relative to the chart), or a Helm template error.
- Sync fails with `exceeded quota` → see (a).
- `Degraded` after successful sync → pods unhealthy; see (a)/(d).
- Permanent `OutOfSync` on fields mutated by controllers; ArgoCD here uses `application.resourceTrackingMethod: annotation` (from `helm-releases/argocd/values.yaml`).

**Remediation**
- Fix the Application manifest or values in the app IaC repo and push; or `argocd repo add <url> --username ... --password ...` for private repos.
- Render locally to reproduce: `helm template <chart-path> -f <values-file>`.
- `argocd app sync <app-name> --retry-limit 3` once fixed.

**Escalate to rollback** if the app degraded right after a new revision synced → [rollback § 4](rollback-runbook.md#4-argocd-managed-applications).

---

## (f) DNS not resolving

**Detection**
```bash
dig +short <host>
kubectl get pods -n external-dns                  # is ExternalDNS installed at all?
kubectl -n external-dns logs deploy/external-dns --tail=100
aws route53 list-hosted-zones --query 'HostedZones[].[Name,Id]' --output table
aws cloudformation describe-stacks --stack-name WorkshopPlatformDev --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text
```

**Likely causes**
- ExternalDNS isn't installed — `scripts/deploy-dev.sh` does not install it (see [deployment-runbook § ExternalDNS](deployment-runbook.md#externaldns-optional-manual)).
- `helm-releases/external-dns/values.yaml` still has placeholders: `domainFilters: [example.com]` and `role-arn: arn:aws:iam::ACCOUNT_ID:role/external-dns` → `AccessDenied` / no matching zone in logs.
- No hosted zone: the `DnsZone` construct is only created when `domainName` is set in `cdk/bin/cdk.ts` (none of the three stacks set it today).
- Hosted zone exists but the parent domain's NS records don't delegate to it.
- In-cluster DNS (CoreDNS) failing: `kubectl -n kube-system get pods -l k8s-app=kube-dns`; or `allow-dns` NetworkPolicy missing in the app namespace (see (b)).

**Remediation**
- Set `domainName` on the stack, deploy, delegate NS records, create the IRSA role, fix the values file, install ExternalDNS.
- Workaround while DNS is down: create the record manually in Route 53 pointing to the ingress NLB hostname.

**Escalate to rollback:** rarely — DNS issues are almost always fix-forward. Roll back only if a CDK change deleted/replaced the hosted zone → [rollback § 2](rollback-runbook.md#2-cdk-infrastructure-cloudformation).

---

## (g) Metrics missing

**Detection**
```bash
kubectl get servicemonitors -A
kubectl get servicemonitor <name> -n <ns> -o yaml | grep -A3 labels
kubectl get networkpolicy allow-prometheus-scrape -n <ns>
kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/targets?state=any' | \
  jq -r '.data.activeTargets[] | [.labels.job, .health, .lastError] | @tsv'
```

**Likely causes**
- **ServiceMonitor missing the `release: prometheus` label.** kube-prometheus-stack defaults to `serviceMonitorSelectorNilUsesHelmValues: true`, so Prometheus only selects ServiceMonitors labelled `release: prometheus`. The ServiceMonitor example in `docs/onboarding.md` has no labels and will be ignored.
- `allow-prometheus-scrape` missing, or the metrics port isn't **8080 or 9090** — the policy only opens those two ports from `monitoring`.
- ServiceMonitor `selector.matchLabels` doesn't match the Service labels, or `endpoints[].port` doesn't match a **named** Service port.
- App doesn't expose `/metrics`.

**Remediation**
```bash
kubectl label servicemonitor <name> -n <ns> release=prometheus
kubectl apply -f k8s/network-policies/default-deny.yaml -n <ns>
```
Make permanent in the app chart. See [monitoring-guide.md § ServiceMonitor convention](monitoring-guide.md#servicemonitor-convention-for-app-metrics).

**Escalate to rollback** if all metrics vanished right after a `prometheus` release upgrade → [rollback § 1](rollback-runbook.md#1-helm-releases).

---

## (h) Node capacity

**Detection**
```bash
kubectl top nodes        # requires metrics-server, which this repo does NOT install;
                         # "Metrics API not available" means use the commands below
kubectl describe nodes | grep -A8 'Allocated resources'
kubectl get pods -A -o wide --field-selector=status.phase=Pending
kubectl get nodes -L environment,node.kubernetes.io/instance-type
aws eks describe-nodegroup --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" \
  --nodegroup-name "$(aws eks list-nodegroups --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" --query 'nodegroups[0]' --output text)" \
  --query 'nodegroup.[scalingConfig,instanceTypes,status,health]'
```
PromQL (Prometheus port-forward above): `sum by (node) (kube_pod_container_resource_requests{resource="cpu"}) / sum by (node) (kube_node_status_allocatable{resource="cpu"})`.

**Likely causes**
- Shared services alone take a significant share of small nodes (Prometheus requests `200m/512Mi` with `2Gi` limit, 2× ingress-nginx, ArgoCD, Grafana, node-exporter, etc.).
- **Pod-count limit:** with Amazon VPC CNI defaults, `t3.medium` fits ~17 pods/node and `t3.large` ~35 — `Too many pods` hits before CPU/memory on dev.
- Node group at max: dev max 3, staging max 5, prod max 10 (`cdk/bin/cdk.ts`). There is **no cluster autoscaler** in this repo — the node group stays at `desiredSize` unless changed.
- Node `NotReady`: check `kubectl describe node <node>` conditions (MemoryPressure/DiskPressure).

**Remediation**
- Short-term: scale the managed node group within min/max:
  ```bash
  aws eks update-nodegroup-config --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" \
    --nodegroup-name <nodegroup> --scaling-config minSize=1,maxSize=3,desiredSize=3
  ```
  (This drifts from CDK; codify it next.)
- Permanent: change `nodeDesiredSize` / `nodeMaxSize` / `nodeInstanceTypes` for the stack in `cdk/bin/cdk.ts` (defaults live in `cdk/lib/constructs/eks-cluster.ts`), then `npx cdk diff` + `npx cdk deploy`. Changing instance type replaces the node group (`forceUpdate: true` drains pods).

**Escalate to rollback** if capacity dropped right after a CDK change to the node group → [rollback § 2.2](rollback-runbook.md#22-successful-deploy-that-made-things-worse).
