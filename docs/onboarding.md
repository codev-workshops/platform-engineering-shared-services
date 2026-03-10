# App Team Onboarding Guide

This document explains how application teams deploy their workloads onto the shared workshop platform.

## Prerequisites

1. **kubectl access** — configured for the workshop EKS cluster
2. **Helm 3.x** — installed locally
3. **Container registry** — images pushed to ECR

## Steps

### 1. Create a Namespace

Each application gets its own Kubernetes namespace:

```bash
kubectl create namespace <app-name>-<env>
# Example: kubectl create namespace decomposition-dev
```

### 2. Deploy with Helm

Your app-specific Helm charts live in your own IaC repo (e.g., `app_dotnet_angular_containerized_decomposition_iac`). Deploy them into your namespace:

```bash
helm upgrade --install <service-name> charts/<service-name> \
  -f environments/<env>/values.yaml \
  -n <app-namespace>
```

### 3. Ingress

The shared NGINX Ingress Controller handles L7 routing. Your Helm charts should include an `Ingress` resource with:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

### 4. Monitoring

Add a `ServiceMonitor` resource to your Helm chart for Prometheus to scrape your service metrics:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-service
spec:
  selector:
    matchLabels:
      app: my-service
  endpoints:
    - port: http
      path: /metrics
```

### 5. DNS

ExternalDNS automatically creates Route 53 records for Ingress resources with the correct annotations.
