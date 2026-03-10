# Platform Architecture

## Overview

The workshop platform runs on AWS EKS with shared services for ingress, TLS, DNS, and monitoring. Application teams deploy their own workloads into dedicated namespaces.

```
┌─────────────────────────────────────────────────────────┐
│                     AWS Account                          │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │               VPC (10.x.0.0/16)                 │    │
│  │                                                   │    │
│  │  ┌──────────────────────────────────────────┐    │    │
│  │  │           EKS Cluster                     │    │    │
│  │  │                                            │    │    │
│  │  │  ┌──────────┐  ┌──────────┐               │    │    │
│  │  │  │ ingress- │  │  cert-   │               │    │    │
│  │  │  │  nginx   │  │ manager  │               │    │    │
│  │  │  └──────────┘  └──────────┘               │    │    │
│  │  │  ┌──────────┐  ┌──────────┐               │    │    │
│  │  │  │prometheus│  │ external │               │    │    │
│  │  │  │ +grafana │  │   dns    │               │    │    │
│  │  │  └──────────┘  └──────────┘               │    │    │
│  │  │                                            │    │    │
│  │  │  ┌────────────────────────────────────┐   │    │    │
│  │  │  │  App Namespaces (per demo app)      │   │    │    │
│  │  │  │  - decomposition-dev                │   │    │    │
│  │  │  │  - decomposition-staging            │   │    │    │
│  │  │  │  - (other workshop apps)            │   │    │    │
│  │  │  └────────────────────────────────────┘   │    │    │
│  │  └──────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐  ┌──────────┐                             │
│  │ Route 53 │  │   ECR    │                             │
│  └──────────┘  └──────────┘                             │
└─────────────────────────────────────────────────────────┘
```

## Terraform Modules

| Module | Purpose |
|--------|---------|
| `networking` | VPC, subnets, NAT gateways, security groups |
| `eks-cluster` | EKS cluster, managed node groups, IRSA |
| `dns` | Route 53 hosted zone (if needed) |

## Helm Releases

| Release | Namespace | Purpose |
|---------|-----------|---------|
| `ingress-nginx` | `ingress-nginx` | L7 load balancing and routing |
| `cert-manager` | `cert-manager` | Automatic TLS certificate management |
| `kube-prometheus-stack` | `monitoring` | Metrics, alerting, dashboards |
| `external-dns` | `external-dns` | Automatic DNS record management |
