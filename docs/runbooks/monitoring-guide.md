# Monitoring Guide

What the platform's monitoring stack is, how to reach it, how apps plug in, and — honestly — what is **not** set up yet.

## Stack overview

| Item | Value |
|------|-------|
| Chart | `prometheus-community/kube-prometheus-stack` |
| Helm release | `prometheus` |
| Namespace | `monitoring` |
| Values (layered in this order) | `helm-releases/monitoring/prometheus/values.yaml`, `helm-releases/monitoring/grafana/values.yaml` |
| Installed by | Phase 4 of `scripts/deploy-dev.sh` ([deployment-runbook.md](deployment-runbook.md#5-phase-4--install-shared-helm-releases-in-this-order)) |

Configured in `helm-releases/monitoring/prometheus/values.yaml`:

| Component | Setting |
|-----------|---------|
| Prometheus | `retention: 7d`; requests `200m` CPU / `512Mi`; limits `1000m` / `2Gi`; PVC `20Gi` `ReadWriteOnce` |
| Alertmanager | `enabled: true`; requests `50m` / `64Mi`; **no receivers configured** |
| node-exporter | enabled |
| kube-state-metrics | enabled |

Configured in `helm-releases/monitoring/grafana/values.yaml` (under the `grafana:` key of kube-prometheus-stack):

| Setting | Value |
|---------|-------|
| `adminPassword` | `changeme` (**change this** — see gaps) |
| Persistence | enabled, `5Gi` |
| Resources | requests `100m` / `128Mi`; limits `500m` / `256Mi` |
| Ingress | **not configured** → access is port-forward only |
| `dashboardProviders` | one file provider `default` at `/var/lib/grafana/dashboards/default` |

Other components already exporting metrics via ServiceMonitors: `ingress-nginx` (`controller.metrics.serviceMonitor.enabled: true`) and `cert-manager` (`prometheus.servicemonitor.enabled: true`).

Services created by the release (names derive from release `prometheus`):

| Service | Port | What |
|---------|------|------|
| `prometheus-grafana` | 80 | Grafana UI |
| `prometheus-kube-prometheus-prometheus` | 9090 | Prometheus UI/API |
| `prometheus-kube-prometheus-alertmanager` | 9093 | Alertmanager UI/API |
| `prometheus-kube-state-metrics` | 8080 | kube-state-metrics |
| `prometheus-prometheus-node-exporter` | 9100 | node-exporter |

## Access

```bash
aws eks update-kubeconfig --name workshop-dev --region us-east-1 --alias workshop-dev

# Grafana → http://localhost:3000  (user: admin)
kubectl -n monitoring port-forward svc/prometheus-grafana 3000:80
kubectl -n monitoring get secret prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo

# Prometheus → http://localhost:9090
kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090

# Alertmanager → http://localhost:9093
kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-alertmanager 9093:9093
```

To expose Grafana via ingress instead, add to `helm-releases/monitoring/grafana/values.yaml` and re-run the Phase 4 `prometheus` install:

```yaml
grafana:
  ingress:
    enabled: true
    ingressClassName: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-staging
    hosts: [grafana.<your-domain>]
    tls:
      - hosts: [grafana.<your-domain>]
        secretName: grafana-tls
```

## Dashboards

- `helm-releases/monitoring/grafana/` currently contains only `values.yaml` — **there are no custom dashboard JSON files in the repo**. The `dashboardProviders` entry points at `/var/lib/grafana/dashboards/default`, but nothing populates it (no `dashboards:` or `dashboardsConfigMaps:` key).
- What you do get: kube-prometheus-stack's built-in dashboards (`defaultDashboardsEnabled: true` upstream) — Kubernetes compute resources by cluster/namespace/pod/node, node-exporter, Prometheus, Alertmanager, CoreDNS, etc.
- To add a dashboard: either commit JSON and reference it under `grafana.dashboards.default.<name>.json` / `file:` in the values file, or ship a ConfigMap labelled `grafana_dashboard: "1"` (picked up by the Grafana sidecar) from the app chart.

```bash
kubectl get configmap -n monitoring -l grafana_dashboard=1
```

## ServiceMonitor convention for app metrics

Apps expose Prometheus metrics and ship a `ServiceMonitor` in their own Helm chart (see [`docs/onboarding.md`](../onboarding.md)). Three rules, all required:

1. **Label it `release: prometheus`.** Prometheus here only selects ServiceMonitors (and PrometheusRules) with that label (kube-prometheus-stack default `serviceMonitorSelectorNilUsesHelmValues: true`; not overridden in our values). The onboarding example omits this label — add it.
2. **Use a named Service port** that matches `endpoints[].port`.
3. **Serve metrics on TCP 8080 or 9090.** The `allow-prometheus-scrape` NetworkPolicy in `k8s/network-policies/default-deny.yaml` only allows ingress from the `monitoring` namespace on those two ports; any other port is silently blocked by `default-deny-all`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  labels: { app: my-service }
spec:
  selector: { app: my-service }
  ports:
    - name: http          # named port referenced below
      port: 80
      targetPort: 8080    # 8080 or 9090 for allow-prometheus-scrape
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-service
  labels:
    release: prometheus   # required for discovery
spec:
  selector:
    matchLabels: { app: my-service }
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

Verify:

```bash
kubectl get servicemonitors -A
kubectl get servicemonitors -A -l release=prometheus           # what Prometheus will actually pick up
kubectl get networkpolicy allow-prometheus-scrape -n decomposition-dev
# Prometheus UI → Status → Targets, or:
curl -s 'http://localhost:9090/api/v1/targets?state=active' | \
  jq -r '.data.activeTargets[] | [.labels.namespace, .labels.job, .health] | @tsv' | sort
```

## Alert rules

kube-prometheus-stack ships a default rule set (node, kubelet, kube-state-metrics, Prometheus, Alertmanager, etcd, etc.) as `PrometheusRule` objects. No custom rules exist in this repo.

```bash
kubectl get prometheusrules -A
kubectl -n monitoring get prometheusrule -o name | head

# Loaded rule groups and currently firing alerts (Prometheus port-forward running)
curl -s http://localhost:9090/api/v1/rules  | jq -r '.data.groups[].name'
curl -s http://localhost:9090/api/v1/alerts | jq -r '.data.alerts[] | [.labels.severity, .labels.alertname, .state] | @tsv'

# Alerts as Alertmanager sees them
curl -s http://localhost:9093/api/v2/alerts | jq -r '.[] | [.labels.severity, .labels.alertname, .status.state] | @tsv'

# Effective Alertmanager config
kubectl -n monitoring get secret alertmanager-prometheus-kube-prometheus-alertmanager \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
```

Custom rules for an app: ship a `PrometheusRule` labelled `release: prometheus` (same selector rule as ServiceMonitors).

### Useful PromQL

| Question | Query |
|----------|-------|
| Targets down | `up == 0` |
| Pods not ready by namespace | `sum by (namespace) (kube_pod_status_ready{condition="false"})` |
| Container restarts (1h) | `sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])) > 0` |
| Namespace quota usage | `kube_resourcequota{namespace="decomposition-dev", type="used"} / ignoring(type) kube_resourcequota{namespace="decomposition-dev", type="hard"}` |
| Node CPU requested vs allocatable | `sum by (node) (kube_pod_container_resource_requests{resource="cpu"}) / sum by (node) (kube_node_status_allocatable{resource="cpu"})` |
| Node memory available % | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes` |
| Ingress 5xx rate | `sum by (ingress) (rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))` |
| Certs expiring < 14d | `(certmanager_certificate_expiration_timestamp_seconds - time()) < 14*24*3600` |

## Known gaps

| Gap | Impact | Suggested fix |
|-----|--------|---------------|
| **No Alertmanager receivers** — the effective config routes everything (including `Watchdog`) to the `"null"` receiver. No PagerDuty, Slack, email, or Opsgenie integration. | Alerts fire in Prometheus/Alertmanager UIs but **nobody is notified**. | Add `alertmanager.config.receivers` / `route` to `helm-releases/monitoring/prometheus/values.yaml`, with the integration key/webhook in a Kubernetes Secret (not in git). |
| No on-call / escalation process defined | Unclear who responds | Fill in the template below. |
| Grafana `adminPassword: changeme` committed in values | Anyone with port-forward access knows the password | Use `grafana.admin.existingSecret` with a Secret created out-of-band; rotate. |
| No Grafana ingress | Port-forward only | See [Access](#access). |
| No custom dashboards in repo | Only upstream defaults | See [Dashboards](#dashboards). |
| Onboarding ServiceMonitor example lacks `release: prometheus` | App metrics silently not scraped | Update `docs/onboarding.md` example. |
| No metrics-server | `kubectl top` and HPA don't work | Install `metrics-server` (EKS add-on or Helm). |
| Prometheus retention 7d on a single 20Gi PVC, no remote write | No long-term history; data lost on PVC loss/teardown | Add remote write (e.g. Amazon Managed Prometheus) if history matters. |

## Escalation procedure (template)

> **Fill this in.** Nothing below is wired up yet — Alertmanager has no receivers, so these contacts must be paged manually until an integration is configured.

### Severity levels

| Severity | Definition | Examples on this platform | Response target | Notify |
|----------|------------|---------------------------|-----------------|--------|
| **SEV1 — Critical** | Platform-wide outage or data loss; all/most apps down | EKS API unreachable; all nodes NotReady; `ingress-nginx` down (all hosts 5xx); accidental `cdk destroy` / teardown on a shared env | Ack ≤ `<15 min>`, all-hands | Primary + secondary on-call, platform lead, `<incident channel>` |
| **SEV2 — Major** | One shared service degraded or one environment down | cert-manager not issuing (certs near expiry); ArgoCD unable to sync any app; prod namespace quota exhausted; monitoring down | Ack ≤ `<30 min>` | Primary on-call, `<platform channel>` |
| **SEV3 — Minor** | Single app/namespace affected, workaround exists | One app's NetworkPolicy blocking traffic; one ServiceMonitor not scraped; dev cluster capacity | Next business day `<or N h>` | `<platform channel>` / ticket |
| **SEV4 — Low** | Cosmetic / no user impact | Dashboard missing; non-critical alert noise | Backlog | Ticket in `<tracker>` |

### Contacts

| Role | Name | Contact | Hours |
|------|------|---------|-------|
| Primary on-call (platform) | `<name>` | `<phone / PagerDuty schedule>` | `<hours / TZ>` |
| Secondary on-call (platform) | `<name>` | `<phone / PagerDuty schedule>` | `<hours / TZ>` |
| Platform engineering lead | `<name>` | `<email / Slack>` | `<hours>` |
| App team (`dotnet-angular-monolith`, owner of `decomposition-*` namespaces) | `<name>` | `<email / Slack>` | `<hours>` |
| AWS account owner (account `599083837640`) | `<name>` | `<email>` | `<hours>` |
| AWS Support | — | `<support plan / case URL>` | — |

### Escalation path

1. **Detect** — alert / user report / failed deploy. Open an incident in `<incident channel>`; assign an incident commander.
2. **Triage (≤ 15 min)** — run the "first 60 seconds" commands in [incident-response.md](incident-response.md), assign a severity.
3. **Mitigate** — follow the matching section of [incident-response.md](incident-response.md); if the last change is the cause, use [rollback-runbook.md](rollback-runbook.md).
4. **Escalate** if not mitigated within: SEV1 `<30 min>` → platform lead + AWS Support; SEV2 `<1 h>` → secondary on-call + platform lead; SEV3 `<1 business day>` → platform lead.
5. **Communicate** — status updates every `<30 min>` (SEV1) / `<1 h>` (SEV2) in `<status channel>`.
6. **Close & review** — postmortem within `<5 business days>` for SEV1/SEV2; link it from `<postmortem location>`.

### Wiring alerts to the path (when ready)

Example shape for `helm-releases/monitoring/prometheus/values.yaml` — keep keys/URLs in a Secret, not in git:

```yaml
alertmanager:
  config:
    route:
      receiver: platform-slack
      group_by: [namespace, alertname]
      routes:
        - matchers: [alertname = "Watchdog"]
          receiver: "null"
        - matchers: [severity = "critical"]
          receiver: platform-pagerduty
    receivers:
      - name: "null"
      - name: platform-slack
        slack_configs:
          - api_url_file: /etc/alertmanager/secrets/<secret-name>/slack-webhook
            channel: "<#platform-alerts>"
            send_resolved: true
      - name: platform-pagerduty
        pagerduty_configs:
          - routing_key_file: /etc/alertmanager/secrets/<secret-name>/pagerduty-key
  alertmanagerSpec:
    secrets: [<secret-name>]
```
