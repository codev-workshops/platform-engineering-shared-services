# Platform Runbooks

Operational runbooks for the shared workshop platform (EKS + shared Helm releases). Every command uses the release names, namespaces, stack names, and file paths that exist in this repo. Run commands from the repo root unless a step says `cd cdk`.

| Runbook | Use it when |
|---------|-------------|
| [Deployment](deployment-runbook.md) | Standing up or upgrading an environment (mirrors the 5 phases of `scripts/deploy-dev.sh`) |
| [Rollback](rollback-runbook.md) | A change made things worse and you need to decide between rollback and fix-forward, per layer |
| [Incident Response](incident-response.md) | Something is broken and you need a detection → cause → remediation decision tree |
| [Monitoring Guide](monitoring-guide.md) | Accessing Prometheus/Grafana/Alertmanager, adding app metrics, and the escalation template |

## Quick reference

| Thing | Value | Defined in |
|-------|-------|------------|
| CDK stacks | `WorkshopPlatformDev`, `WorkshopPlatformStaging`, `WorkshopPlatformProd` | `cdk/bin/cdk.ts` |
| EKS cluster names | `workshop-dev`, `workshop-staging`, `workshop-prod` (`workshop-${environment}`) | `cdk/lib/platform-stack.ts` |
| Region | `us-east-1` (default; `AWS_REGION` / `CDK_DEFAULT_REGION` override) | `scripts/deploy-dev.sh`, `cdk/bin/cdk.ts` |
| App namespaces | dev stack: `decomposition-dev`, `decomposition-staging`; staging stack: `decomposition-staging`; prod stack: `decomposition-prod` | `cdk/bin/cdk.ts` |

| Helm release | Namespace | Chart | Values |
|--------------|-----------|-------|--------|
| `ingress-nginx` | `ingress-nginx` | `ingress-nginx/ingress-nginx` | `helm-releases/ingress-nginx/values.yaml` |
| `cert-manager` | `cert-manager` | `jetstack/cert-manager` | `helm-releases/cert-manager/values.yaml` (+ `cluster-issuer.yaml`) |
| `prometheus` | `monitoring` | `prometheus-community/kube-prometheus-stack` | `helm-releases/monitoring/prometheus/values.yaml` + `helm-releases/monitoring/grafana/values.yaml` |
| `argocd` | `argocd` | `argo/argo-cd` | `helm-releases/argocd/values.yaml` |
| `external-dns` (not installed by `deploy-dev.sh`) | `external-dns` | `external-dns/external-dns` | `helm-releases/external-dns/values.yaml` |

Related docs: [`../architecture.md`](../architecture.md), [`../onboarding.md`](../onboarding.md).
