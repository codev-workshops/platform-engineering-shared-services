# Platform Engineering Shared Services

Shared platform infrastructure used across all workshop demo applications. Provisions and manages the EKS cluster, networking, ingress, TLS, DNS, and observability stack.

## What This Repo Manages

| Component | Tool | Description |
|-----------|------|-------------|
| EKS Cluster | Terraform | AWS EKS cluster with managed node groups |
| VPC/Networking | Terraform | VPC, subnets, security groups, NAT gateways |
| DNS | Terraform + ExternalDNS | Route 53 hosted zone and automatic DNS record management |
| Ingress Controller | Helm (ingress-nginx) | NGINX Ingress Controller for L7 routing |
| TLS Certificates | Helm (cert-manager) | Automatic Let's Encrypt TLS certificates |
| Monitoring | Helm (Prometheus + Grafana) | Cluster-wide metrics and dashboards |

## Project Structure

```
terraform/
├── modules/
│   ├── eks-cluster/         # EKS cluster, node groups, IRSA roles
│   ├── networking/          # VPC, subnets, security groups, NAT
│   └── dns/                 # Route 53 hosted zone
├── environments/
│   ├── dev/                 # Dev environment tfvars + backend config
│   ├── staging/             # Staging environment
│   └── prod/                # Production environment
helm-releases/
├── ingress-nginx/           # NGINX Ingress Controller values
├── cert-manager/            # cert-manager + ClusterIssuer
├── monitoring/
│   ├── prometheus/          # Prometheus stack values
│   └── grafana/             # Grafana dashboards + values
└── external-dns/            # ExternalDNS for Route 53
docs/
├── architecture.md          # Platform architecture overview
└── onboarding.md            # How app teams onboard to the platform
```

## Usage

### Provision Infrastructure

```bash
# Initialize and apply for dev environment
cd terraform/environments/dev
terraform init
terraform plan
terraform apply
```

### Install Shared Helm Releases

```bash
# Ingress controller
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -f helm-releases/ingress-nginx/values.yaml \
  -n ingress-nginx --create-namespace

# cert-manager
helm upgrade --install cert-manager jetstack/cert-manager \
  -f helm-releases/cert-manager/values.yaml \
  -n cert-manager --create-namespace

# Monitoring stack
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -f helm-releases/monitoring/prometheus/values.yaml \
  -n monitoring --create-namespace
```

## App Team Onboarding

Application teams deploy their own Helm charts into dedicated namespaces. They depend on this shared infrastructure for:

1. **EKS cluster** — compute, networking, IAM
2. **Ingress controller** — L7 routing via Ingress resources
3. **cert-manager** — automatic TLS via cert-manager annotations
4. **Monitoring** — Prometheus ServiceMonitor resources for metrics
5. **DNS** — automatic DNS records via ExternalDNS annotations

See [`docs/onboarding.md`](docs/onboarding.md) for detailed instructions.

## Workshop Demo Applications Using This Platform

| App Repos | Description |
|-----------|-------------|
| `app_dotnet_angular_containerized_decomposition_*` | .NET + Angular monolith decomposition |
