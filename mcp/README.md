# Driftmower MCP

Driftmower MCP exposes a Kubernetes cluster through the Model Context Protocol.
It provides cluster identity, workload and resource discovery, provisioning
capabilities, admission-policy guidance and namespace readiness. Optional
integrations add Prometheus metrics, Loki logs and persisted Driftmower backend
analysis. Supported workload restarts and standalone-pod termination can be
enabled explicitly.

HTTP clients authenticate with OIDC. Kubernetes access checks use the verified
caller's identity and RBAC; the server's ServiceAccount supplies credentials for
cluster discovery and authorization reviews. Installed APIs and successful
authorization checks do not establish controller health or admission success.

The server supports stdio and Streamable HTTP at `/mcp`. An optional browser
explorer is served at `/ui`. HTTP health and metrics endpoints use a separate
port: `/healthz`, `/readyz`, `/startupz` and `/metrics`.

## Development

```bash
npm ci
npm run build
npm test
npm run typecheck
npm run lint
```

Run `npm run dev` to build the explorer and start the TypeScript server, or
`npm start` to run the compiled server. Configuration defaults to stdio with
the backend enabled, which requires `DRIFTMOWER_BE_SERVICE_TOKEN`. Set
`DRIFTMOWER_BE_ENABLED=false` to run without backend analysis.

For authenticated HTTP, set `DRIFTMOWER_MCP_TRANSPORT=http`, `MCP_PUBLIC_URL`
and `OIDC_ISSUER`. Configure the Kubernetes token and CA files for the target
cluster.

## Go implementation (preview)

A Go rewrite lives beside the TypeScript server in `cmd/` and `internal/`. It
serves the same tools, routes, ports, environment variables and metric names,
and renders the `/ui` explorer on the server instead of in the browser. The
TypeScript server remains the primary image; the Go server is published as a
secondary image, `ghcr.io/codemowers/driftmower-mcp-go`, for side-by-side
testing.

```bash
go test -race ./cmd/... ./internal/...
go run ./cmd/driftmower-mcp            # same environment as the TypeScript server
docker compose --profile go run --build --rm test-go   # smoke test against the Go image
```

`KUBECONFIG` points a local Go server at a cluster. To deploy it beside the
primary release, use its own namespace; the chart's ClusterRole name is a
value so the two releases do not rebind each other:

```bash
skaffold run -p go --namespace driftmower-go
```

Differences from the TypeScript server: `MCP_SESSION_IDLE_MS` sets the MCP
session idle timeout (default 30 minutes); booleans accept only `true` or
`false`; `DRIFTMOWER_UI_PUBLIC_URL` and `--backend-url` are not read.

## Environment variables

Defaults are defined in `config/default.json`; environment mappings are in
`config/custom-environment-variables.json`. Empty optional values mean unset.
Durations below are milliseconds. `--backend-url` overrides `DRIFTMOWER_BE_URL`.

### Server and authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIFTMOWER_MCP_TRANSPORT` | `stdio` | Transport: stdio or http. |
| `DRIFTMOWER_MCP_HOST` | `::` | HTTP and health bind address. |
| `DRIFTMOWER_MCP_PORT` | `3000` | HTTP port. |
| `DRIFTMOWER_MCP_HEALTH_PORT` | `3001` | Health and metrics port. |
| `DRIFTMOWER_MCP_LOG_LEVEL` | `info` | debug, info, warn or error. |
| `MCP_PUBLIC_URL` | `http://127.0.0.1:3000` | Public server base URL; advertised resource is this URL plus /mcp. |
| `DRIFTMOWER_UI_PUBLIC_URL` | `unset` | Optional external UI link on the landing page. |
| `MCP_AUTH_ENABLED` | `true` | Verify HTTP bearer tokens. |
| `MCP_OAUTH_CLIENT_ID` | `unset` | Registered client ID advertised for OAuth discovery. |
| `MCP_SERVICE_ACCOUNT_AUTH_ENABLED` | `false` | Enable audience-bound ServiceAccount authentication alongside OIDC. |
| `MCP_INVALIDATE_TOKEN` | `unset` | Shared bearer token for POST /api/cache/invalidate. |
| `MCP_INVALIDATE_ALLOWED_SUBJECTS` | `unset` | Comma-separated ServiceAccount usernames allowed to invalidate caches after TokenReview. |
| `MCP_WORKLOAD_RESTART_ENABLED` | `false` | Enable guarded restart and standalone-pod termination tools; requires authenticated HTTP. |

When ServiceAccount authentication is enabled, workers must use a projected
`serviceAccountToken` whose audience equals the advertised MCP resource URL,
including `/mcp`. Read the projected file on each request to follow rotation.
TokenReview verifies the audience and ServiceAccount identity; reviewed usernames
and groups are used directly, without OIDC prefixes. Tool access still depends
on caller RBAC. The MCP server needs permission to create TokenReviews.

### OIDC

| Variable | Default | Purpose |
| --- | --- | --- |
| `OIDC_ISSUER` | `unset` | Required issuer for authenticated HTTP. |
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

Setting `OBSERVABILITY_ENABLED=true`, `PROMETHEUS_URL` or `LOKI_URL` enables
observability configuration and requires authenticated HTTP. Available sources
determine which metrics and log queries can be served.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBSERVABILITY_ENABLED` | `false` | Enable observability without explicit Prometheus or Loki URLs. |
| `PROMETHEUS_URL` | `unset` | Prometheus API base URL. |
| `LOKI_URL` | `unset` | Loki API base URL. |
| `OBSERVABILITY_TIMEOUT_MS` | `10000` | Observability request timeout. |
| `OBSERVABILITY_MAX_CONCURRENT_REQUESTS` | `8` | Global upstream request concurrency. |
| `OBSERVABILITY_MAX_QUEUED_REQUESTS` | `32` | Maximum queued upstream requests. |
| `OBSERVABILITY_QUERIES_PER_MINUTE` | `120` | Upstream queries per caller per minute; 0 is unlimited. |
| `OBSERVABILITY_MAX_CONCURRENT_CALLS_PER_CALLER` | `2` | Concurrent metrics and logs tool calls per caller. |
| `OBSERVABILITY_CACHE_TTL_MS` | `15000` | Identical Prometheus-query cache lifetime; 0 disables caching. |

### Browser explorer

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_WEB_UI_ENABLED` | `false` | Serve the explorer; requires authenticated HTTP and its client ID. |
| `MCP_WEB_UI_CLIENT_ID` | `unset` | Public OIDC client for the browser explorer. |
