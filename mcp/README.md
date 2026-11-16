# Driftmower MCP

Driftmower MCP exposes a Kubernetes cluster through the Model Context Protocol.
It provides cluster identity, workload and resource discovery, provisioning
capabilities, admission-policy guidance and namespace readiness. Optional
integrations add Prometheus metrics, Loki logs, version drift and security
advisories from driftmower-crawler, and persisted Driftmower backend analysis. Supported workload restarts and standalone-pod termination can be
enabled explicitly.

HTTP clients authenticate with OIDC. Kubernetes access checks use the verified
caller's identity and RBAC; the server's ServiceAccount supplies credentials for
cluster discovery and authorization reviews. Installed APIs and successful
authorization checks do not establish controller health or admission success.

The server supports stdio and Streamable HTTP at `/mcp`. HTTP health and metrics endpoints use a separate
port: `/healthz`, `/readyz`, `/startupz` and `/metrics`.

## Development

The server is part of the `github.com/codemowers/driftmower` Go module; run
these from the repository root:

```bash
go test -race ./mcp/...
go vet ./mcp/...
golangci-lint run ./mcp/...
go run ./mcp/cmd/driftmower-mcp
```

Configuration defaults to stdio with the backend enabled, which requires
`DRIFTMOWER_BE_SERVICE_TOKEN`. Set `DRIFTMOWER_BE_ENABLED=false` to run
without backend analysis. `KUBECONFIG` points a local server at a cluster.

For authenticated HTTP, set `DRIFTMOWER_MCP_TRANSPORT=http`, `OIDC_CLIENT_ORIGIN`
and `OIDC_IDP_URI`. Configure the Kubernetes token and CA files for the target
cluster.

`skaffold dev -m mcp` from the repository root builds the image and deploys
the chart in `../chart/`.

## Environment variables

Defaults are defined in `internal/config/config.go`. Empty optional values
mean unset. Durations below are milliseconds. Booleans accept only `true` or
`false`.

### Server and authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIFTMOWER_MCP_TRANSPORT` | `stdio` | Transport: stdio or http. |
| `DRIFTMOWER_MCP_HOST` | `::` | HTTP and health bind address. |
| `DRIFTMOWER_MCP_PORT` | `3000` | HTTP port. |
| `DRIFTMOWER_MCP_HEALTH_PORT` | `3001` | Health and metrics port. |
| `DRIFTMOWER_MCP_LOG_LEVEL` | `info` | debug, info, warn or error. |
| `OIDC_CLIENT_ORIGIN` | `http://127.0.0.1:3000` | Public server base URL; advertised resource is this URL plus /mcp. |
| `MCP_AUTH_MODE` | `rbac` | `rbac`: OIDC + caller RBAC; `oidc`: OIDC with all reads; `anonymous`: all reads without login. Relaxed modes disable mutations. |
| `MCP_AUTH_ENABLED` | `true` | Legacy alias: false selects anonymous when MCP_AUTH_MODE is unset. |
| `MCP_SESSION_IDLE_MS` | `1800000` | Close MCP sessions with no open response for this long. |
| `OIDC_CLIENT_ID` | `unset` | Registered client ID advertised for OAuth discovery. |
| `MCP_SERVICE_ACCOUNT_AUTH_ENABLED` | `false` | Enable audience-bound ServiceAccount authentication alongside OIDC. |
| `MCP_INVALIDATE_TOKEN` | `unset` | Shared bearer token for POST /api/cache/invalidate. |
| `MCP_INVALIDATE_ALLOWED_SUBJECTS` | `unset` | Comma-separated ServiceAccount usernames allowed to invalidate caches after TokenReview. |
| `MCP_WORKLOAD_RESTART_ENABLED` | `false` | Enable guarded restart, standalone-pod termination and PVC expansion (`expand_volume`) tools; requires authenticated HTTP. |
| `MCP_USER_ACCESS_ENABLED` | `false` | Enable `list_oidc_users`, `get_oidc_user_access` and `get_my_access`; requires authenticated HTTP and impersonate on users and groups. Other users' rights are shown only to callers who may impersonate users and groups themselves; `get_my_access` shows every caller their own. |
| `MCP_OIDC_USERS_NAMESPACE` | `passmower` | Namespace holding Passmower OIDCUsers. |
| `MCP_USER_ACCESS_CACHE_TTL_MS` | `300000` | How long one user's effective-rights evaluation is reused; `0` disables. |

When ServiceAccount authentication is enabled, workers must use a projected
`serviceAccountToken` whose audience equals the advertised MCP resource URL,
including `/mcp`. Read the projected file on each request to follow rotation.
TokenReview verifies the audience and ServiceAccount identity; reviewed usernames
and groups are used directly, without OIDC prefixes. Tool access still depends
on caller RBAC. The MCP server needs permission to create TokenReviews.

### OIDC

| Variable | Default | Purpose |
| --- | --- | --- |
| `OIDC_IDP_URI` | `unset` | Required issuer for authenticated HTTP. |
| `OIDC_JWKS_URI` | `issuer + /jwks` | JWT verification key endpoint. |
| `MCP_AUDIENCE` | `public URL + /mcp` | Override the accepted OIDC audience. |
| `MCP_NAMESPACES_CLAIM` | `codemowers.io/namespaces` | Namespace-scope claim in OIDC tokens. |
| `OIDC_JWKS_BEARER_TOKEN_FILE` | `unset` | Token file for authenticated JWKS retrieval. |
| `MCP_ALLOWED_CLIENT_IDS` | `unset` | Comma-separated accepted OIDC client IDs; empty accepts any client. |

### Kubernetes

| Variable | Default | Purpose |
| --- | --- | --- |
| `KUBERNETES_API_URL` | `https://kubernetes.default.svc` | Internal Kubernetes API endpoint; HTTPS required. |
| `KUBERNETES_TOKEN_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Server ServiceAccount token file, reread for rotation. |
| `KUBERNETES_CA_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | Kubernetes API CA file. |
| `KUBERNETES_USERNAME_CLAIM` | `sub` | OIDC claim mapped to the Kubernetes username. |
| `KUBERNETES_GROUPS_CLAIM` | `groups` | OIDC claim mapped to Kubernetes groups. |
| `KUBERNETES_USERNAME_PREFIX` | `issuer + #` | Match the API server's OIDC username prefix; - disables it. Default is empty for the email claim or without OIDC. |
| `KUBERNETES_GROUPS_PREFIX` | `unset` | Match the API server's OIDC group prefix. |
| `KUBERNETES_TIMEOUT_MS` | `10000` | Kubernetes request timeout. |
| `MCP_SAR_CACHE_TTL_MS` | `3600000` | SubjectAccessReview cache lifetime; 0 disables caching. |
| `MCP_RBAC_WATCH_ENABLED` | `true` | Invalidate caches when watched RBAC objects, namespaces or CRDs change. |

### Cluster identity

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIFTMOWER_CLUSTER_ID` | `discovered when available` | DNS-style cluster identifier, including provider domain. |
| `KUBERNETES_PUBLIC_API_URL` | `discovered when available` | External Kubernetes API URL for client context selection; HTTPS required. |

### Provisioning

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROVISIONING_MAX_NAMESPACES` | `20` | Maximum namespaces per readiness request. |
| `PROVISIONING_INGRESS_DOMAIN_SUFFIX` | `unset` | Configured fallback ingress domain suffix. |
| `PROVISIONING_CLUSTER_FACT_TTL_MS` | `300000` | Cluster provisioning-fact cache lifetime. |
| `PROVISIONING_TOPOLOGY_TTL_MS` | `60000` | Topology-fact cache lifetime. |
| `PROVISIONING_OPERATOR_TTL_MS` | `30000` | Operator-discovery cache lifetime. |

### Backend analysis

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIFTMOWER_BE_ENABLED` | `true` | Enable persisted backend analysis tools. |
| `DRIFTMOWER_BE_URL` | `http://driftmower-be:3030` | Backend API base URL. |
| `DRIFTMOWER_BE_SERVICE_TOKEN` | `unset` | Required backend credential when enabled. |
| `DRIFTMOWER_BE_TIMEOUT_MS` | `15000` | Backend request timeout. |

### Findings

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRAWLER_URL` | `unset` | driftmower-crawler base URL; enables get_source_findings and get_workload_findings. |
| `CRAWLER_TOKEN_FILE` | `/var/run/secrets/driftmower/crawler/token` | Projected ServiceAccount token for the crawler's audience, reread on every request. |

The crawler must list this server's ServiceAccount among its allowed callers.
Callers who may list `codemowers.io` ContainerImages see every source; others
see only the versions their visible workloads run.

### Backend search

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIFTMOWER_MCP_DEFAULT_LIMIT` | `20` | Default backend search result limit. |
| `DRIFTMOWER_MCP_MAX_LIMIT` | `100` | Maximum backend search result limit. |

### Backend namespace scope

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_SCOPE_SOURCE` | `union` | Backend namespace scope source: claim, rbac or union. |
| `MCP_SCOPE_MAX_NAMESPACES` | `2000` | Maximum namespaces reviewed in a caller's RBAC scope sweep. |

### Observability

Setting `OBSERVABILITY_ENABLED=true`, `PROMETHEUS_URL`, `LOKI_URL` or `ALERTMANAGER_URL` enables
observability configuration and requires authenticated HTTP. Available sources
determine which metrics and log queries can be served.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBSERVABILITY_ENABLED` | `false` | Enable observability without explicit Prometheus or Loki URLs. |
| `PROMETHEUS_URL` | `unset` | Prometheus API base URL. |
| `PROMETHEUS_EXTERNAL_URL` | `unset` | Public Prometheus address for dashboard links to graphs; unset uses Prometheus's `web.external-url`. |
| `LOKI_URL` | `unset` | Loki API base URL. |
| `ALERTMANAGER_URL` | `unset` | Alertmanager API base URL; enables `list_alerts`, `silence_alerts` and `expire_silence`. Reading a namespace's alerts needs `list pods` there, silencing needs `create alertmanagerconfigs.monitoring.coreos.com` there; cluster-wide `list pods` sees every alert. |
| `OBSERVABILITY_TIMEOUT_MS` | `10000` | Observability request timeout. |
| `OBSERVABILITY_ALIGNMENT_MS` | `15000` | Query evaluation and private browser-cache interval. MCP retains no Prometheus responses. |

The `Driftmower` Grafana dashboard is provisioned by the sibling kube chart at
`grafana/files/dashboards/driftmower.json`. Tool response sizes and server-side
execution durations use per-tool histogram heatmaps. The size histogram measures
serialized tool result JSON, excluding JSON-RPC/SSE framing and compression;
the duration excludes network transport. Unknown tool names share `other`.

Memory panels compare process RSS and Go heap, objects, stacks, allocation rate
and GC with retained application structures:

- MCP cache entries, expired entries, capacities, in-flight loads and key bytes;
  workload informer object counts and open MCP sessions.
- Crawler conditional HTTP cache body/key bytes, changelog and release-note
  bytes, parsed releases/advisories, OSV results and informer counts.
- Registry repositories, images, tags, layers and both layer-prefix indexes.
- Scanner aggregate vulnerability summaries, summary classes, informer/store
  counts and ready queue length. Full SBOMs remain on disk.

Payload lengths exclude map/object overhead and spare allocation capacity;
references can share backing storage, so adding payload categories does not
produce total heap usage. Collection counts existing structures and string/body
lengths without serializing full inventories or retaining profiling copies.
