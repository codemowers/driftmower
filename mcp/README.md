# Driftmower MCP

The platform's single MCP gateway. It serves coding agents these tools over one
authenticated endpoint:

- **Drift analysis** — persisted Driftmower snapshots read from the
  driftmower-be API (`search_workloads`, `plan_image_updates`).
- **Provisioning capabilities** — what a cluster offers a workload and what will
  bite you, discovered from Kubernetes directly, with every permission answer
  asked of the cluster authorizer as the caller (`describe_cluster_capabilities`,
  `describe_provisioning_platform`, `list_offerings`,
  `describe_namespace_readiness`, `check_access`), also served as JSON at
  `/api/provisioning/capabilities`.
- **Metrics and logs** — live Prometheus metrics and Loki or Kubernetes pod logs
  (`query_metrics`, `query_logs`), authorized through Kubernetes RBAC.

Everything here is read-only. The server makes non-persistent Kubernetes
SubjectAccessReview requests to check authorization; it does not change
workloads, backend data, or repositories.

Published behind passmower OIDC. Results are scoped to the caller's own
namespaces.

## Software engineering advisory

Engineering advice is bundled with this project and always registered, independent
of Kubernetes, monitoring, and Driftmower services. No external document is fetched
at runtime. Unfinished guidance, including Node.js-specific sections, is marked
`TODO`.

MCP clients can discover Markdown resources through `resources/list` and read them
through `resources/read`. The index URI is `engineering://advisory/index`; section
URIs use the same prefix followed by a path below. Clients using tools can call
`get_engineering_advisory` with `{"path":"developing/logging"}`, or omit `path`
for the index. The tool returns the same Markdown as the resource.

```text
developing/
  general
  logging
  metrics
  health-checks
  local-development
  languages/{python,nodejs,go,rust}
building/
  general
  ci
  languages/{python,nodejs,go,rust}
deploying/
  general
  security
  networking
  storage
  workloads
  observability
```

Maintain the Markdown files under `src/advisory/content/`, following the API path tree (for example, `developing/languages/nodejs.md`). CRD-specific provisioning lives in `crds/<lowercase-kind>.<api-group>.md`, for example `crds/cluster.postgresql.cnpg.io.md`; the same path without `.md` is accepted by `get_engineering_advisory`. Shared persistence advice and the technology-to-resource map remain in `deploying/storage.md`. Each file starts with a `# Title`. The server discovers the tree once at startup and generates the index; adding a file adds its resource and tool path after restart. The build copies the content into `dist/advisory/content/` for packaging, including the container image. The advice is
included in the compiled server and container image. HTTP access uses the
endpoint's existing authentication; local stdio can also read the advice.

## Multiple clusters and administrator guidance

Give each installation a provider-qualified cluster identity. For example:

```bash
DRIFTMOWER_CLUSTER_ID=ee-west-1.codemowers.io
KUBERNETES_PUBLIC_API_URL=https://10.250.10.2:6443
MCP_OAUTH_CLIENT_ID=kube-system.driftmower-mcp
```

The landing page generates Claude Code, Codex and JSON setup snippets using
`driftmower-ee-west-1-codemowers-io`. Another provider's `ee-west-1.example.net`
becomes `driftmower-ee-west-1-example-net`. Sign in to each connection separately.
`MCP_OAUTH_CLIENT_ID` is the public client ID registered with that installation's
identity provider; it is not assumed to be a Codemowers client. Leave it unset
for providers whose clients can register automatically.

At startup, the server reads `default/kubelogin` Ingress. A single concrete
hostname identifies the Passmower OIDC API endpoint (`https://<hostname>`);
removing its leading `kube.` gives the cluster name. The MCP identity and agent
instructions use this discovered endpoint. If the ingress is absent, unreadable,
or has no unambiguous hostname, the configured identity and k3s advertised API
address are retained. Ingress discovery grants `get` only for ingresses named `kubelogin` through
the existing ClusterRole; the application reads the infra-owned ingress in `default` (included in `manifests/templates/observability-rbac.yaml`).

`KUBERNETES_PUBLIC_API_URL` is the fallback administrator-facing API URL found in
kubeconfig, including its port and any proxy path. It may require a VPN. It is
separate from `KUBERNETES_API_URL`, which the MCP server uses internally and
usually leaves at `https://kubernetes.default.svc`. Never infer cluster identity
from that shared in-cluster hostname.

The MCP initialization instructions, `get_cluster_identity`,
and advisory tool responses identify this
connection's cluster. Agents are instructed to compare the external API URL to
local kubeconfig server URLs and use explicit `kubectl --context`. Missing
identity, an unmatched URL (including an alternate endpoint), or ambiguous
credentials require user clarification; context names are only hints. Each
namespace the user works with gets a context named `<cluster>/<namespace>` with
`context.namespace` explicitly set. Agents must use those contexts for kubectl
and Skaffold `deploy.kubeContext`. Passmower endpoints include OIDC exec-plugin
setup guidance using `default.kubelogin` and the configured OIDC issuer.
Without ingress discovery or `DRIFTMOWER_CLUSTER_ID`, setup names fall back to the MCP public URL's
host, but cluster identity remains explicitly unknown. These instructions guide
agents; they do not enforce which context a separate local kubectl process uses.
Drift analysis still uses the configured backend snapshots and their scope,
which can differ from the live cluster exposed by discovery and observability.

Set `ENGINEERING_ADVISORY_OVERRIDE_DIR=/etc/driftmower/advisory` to load
administrator Markdown on top of the bundled defaults. Matching paths such as
`deploying/networking.md` replace the whole bundled document. Other defaults stay
available; new paths add sections. Each file must start with `# Title`; paths
use lowercase letters, digits and hyphens separated by `/`. `index` is reserved.
The index and advisory responses identify bundled versus overridden content.
The landing page and MCP resources/tools all use the same effective documents.

For example, create a ConfigMap from your own Markdown file:

```bash
kubectl --context YOUR_CONTEXT -n kube-system create configmap driftmower-advisory \
  --from-file=networking.md=./networking.md
```

Merge these fields into the MCP Deployment (the ConfigMap key maps to the
advisory's directory path):

```yaml
spec:
  template:
    spec:
      containers:
        - name: driftmower-mcp
          env:
            - name: ENGINEERING_ADVISORY_OVERRIDE_DIR
              value: /etc/driftmower/advisory
          volumeMounts:
            - name: advisory
              mountPath: /etc/driftmower/advisory
              readOnly: true
      volumes:
        - name: advisory
          configMap:
            name: driftmower-advisory
            items:
              - key: networking.md
                path: deploying/networking.md
```

Mount overrides separately from the bundled content. Files are loaded once at
startup; restart the Deployment after updating its ConfigMap. A configured but
missing/unreadable directory, invalid document, or directory cycle fails startup
rather than silently ignoring administrator policy. Only mount content intended
for public reading: the root guidance page is unauthenticated.

## Requirements

- Node.js 24 or compatible current LTS runtime
- For drift analysis: a reachable driftmower-be, and a service token it accepts
- For metrics/logs: Passmower OIDC, Kubernetes API access, and the RBAC below

The backend must be recent enough to allow `id` and `status` in a `/reports`
query and to allow `$select` of the workload and tag columns on
`/image-usages` (driftmower-be #59 and #82). An older backend answers 400 to
these queries; the affected tools report the backend error. Readiness checks
only whether the local MCP listener has started, without querying dependencies.

## Install

```bash
npm install
npm run build
```

## Container publishing

CI publishes to `ghcr.io/codemowers/driftmower-mcp` after checks pass.
Pushes to `main` or `master` publish `:latest`; Git tag pushes publish the exact
Git tag as the image tag (for example, `v1.2.3` becomes `:v1.2.3`) without
changing `:latest`. Git tags must be valid Docker tags. Other branches run checks
without publishing. The image records its Git commit in its OCI revision label
and MCP handshake. This private application has no npm package version; the
lockfile pins dependencies for reproducible container builds.

## Configuration

Default configuration lives in `config/default.json` and can be overridden with
environment variables:

```bash
DRIFTMOWER_BE_URL=http://driftmower-be:3030
DRIFTMOWER_BE_ENABLED=true                  # false for metrics/logs without Driftmower
DRIFTMOWER_BE_SERVICE_TOKEN=dm_svc_...
DRIFTMOWER_BE_TIMEOUT_MS=15000
DRIFTMOWER_MCP_TRANSPORT=stdio
DRIFTMOWER_MCP_HOST=::                       # dual-stack; `::1` or `127.0.0.1` to bind loopback only
DRIFTMOWER_MCP_PORT=3000
DRIFTMOWER_MCP_HEALTH_PORT=3001
DRIFTMOWER_MCP_DEFAULT_LIMIT=20
DRIFTMOWER_MCP_MAX_LIMIT=100
DRIFTMOWER_MCP_LOG_LEVEL=info

# Authentication (HTTP transport only; stdio is a local process and is not gated)
OIDC_ISSUER=https://passmower.example        # matched against the token `iss`
OIDC_JWKS_URI=                               # defaults to ${OIDC_ISSUER}/jwks
OIDC_JWKS_BEARER_TOKEN_FILE=                 # bearer token for the key set, e.g. the mounted SA token when the
                                             # issuer is a kube-apiserver with --anonymous-auth=false
MCP_AUDIENCE=https://driftmower-mcp          # verified strictly as `aud`
MCP_PUBLIC_URL=https://driftmower-mcp.ee-lte-1.codemowers.io
MCP_AUTH_ENABLED=true                        # false only for a server no one can reach

# Provisioning facts are read from Kubernetes directly; optional knobs:
PROVISIONING_MAX_NAMESPACES=20               # namespaces per readiness call or capabilities request (1-200)
PROVISIONING_INGRESS_DOMAIN_SUFFIX=          # fallback when no admission guard publishes one; reported as configured
PROVISIONING_CLUSTER_FACT_TTL_MS=300000
PROVISIONING_TOPOLOGY_TTL_MS=60000
PROVISIONING_OPERATOR_TTL_MS=30000

# Legacy UI public URL setting; the root now always serves the guidance document
DRIFTMOWER_UI_PUBLIC_URL=https://driftmower-ui.ee-lte-1.codemowers.io
```

## Metrics and logs

`list_accessible_namespaces` discovers the namespaces where the cluster's own
authorizer lets the caller `list` pods. It first submits one SubjectAccessReview
with no namespace, which Kubernetes reads as "in all namespaces" and which only
a ClusterRoleBinding satisfies; when that is allowed, every namespace is listed.
Otherwise it lists namespaces with the service account and submits one review
per namespace, sixteen at a time, bounded by `MCP_SCOPE_MAX_NAMESPACES`
(default 2000, preferred namespaces first, then alphabetical; the result says
when it was truncated). No RoleBinding is ever read or interpreted, so the
answer is exact for any authorizer, including aggregated ClusterRoles, custom
role names, ClusterRoleBindings and webhook authorizers. Reviews use the same
verified identity mapping as metrics and logs, never the namespace claim.

The result carries `namespaces`, `clusterWide`, `unknown` (reviews the
authorizer could not evaluate; excluded, not denied), `truncated`, the mapped
`identity` and a `note`. This is visibility, not a grant of permissions:
being listed says nothing about creating or changing anything, and every
operation still checks its own verb. An empty result names the mapped identity
and points at `KUBERNETES_USERNAME_CLAIM` / `KUBERNETES_USERNAME_PREFIX`, since
a wrong mapping and a user with no access look the same to the apiserver. The
service account needs cluster-wide `list` on `namespaces` and `create` on
`subjectaccessreviews`, included in the RBAC manifest. The tool is always
registered, independently of observability configuration or Driftmower
services; calls still require an authenticated caller.

Every SubjectAccessReview this server sends passes through one cache keyed by
the mapped identity and the exact verb, resource, subresource, name and
namespace. Only conclusive answers are stored; an inconclusive review is
retried on the next call. `MCP_SAR_CACHE_TTL_MS` (default 3600000, one hour)
bounds staleness; `0` disables the cache. This server never applies anything,
so a permission revoked inside the window costs at most a 403 the caller's own
kubectl reports and this server did not predict. Freshness comes from
invalidation, and the TTL is the safety net:

- **Watch (default, `MCP_RBAC_WATCH_ENABLED=true`).** The server watches
  Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, Namespaces and
  CRDs. A Role or RoleBinding event flushes the reviews for that namespace, a
  cluster-scoped RBAC event flushes them all, a Namespace event refreshes the
  namespace listing, a CRD event refreshes discovery and the cluster facts. It
  catches every change source (Argo CD, Helm, kubectl, platform-manager) within
  seconds, needs `watch` on those resources (in the RBAC manifest), and falls
  back to the TTL with a warning when the stream cannot be opened.
- **Webhook.** `POST /api/cache/invalidate` with `{"scope":"all"}`,
  `{"scope":"namespace","namespace":"..."}` or `{"scope":"identity","sub":"..."}`
  flushes on demand, for what a watch cannot see (a webhook authorizer whose
  policy changed) or an Argo CD PostSync hook. It is accepted with the
  `MCP_INVALIDATE_TOKEN` shared secret, or with a Kubernetes ServiceAccount
  token that a TokenReview resolves to one of `MCP_INVALIDATE_ALLOWED_SUBJECTS`
  (comma separated, e.g. `system:serviceaccount:argocd:argocd-server`; needs
  `create tokenreviews`). It is a 404 when neither is configured.

`driftmower_mcp_sar_cache_invalidations_total{source}` counts both. On a
cluster with a webhook authorizer and no cooperating webhook call, the TTL is
the real staleness bound.

`explain_storage_class` has been removed. Use `list_storage_classes` for live
settings and operator-authored descriptions, and `list_admission_policies` for
admission behavior. Every provisioning tool reads Kubernetes directly; see [Provisioning Tools](#provisioning-tools).

The same Kubernetes connection also exposes `list_storage_classes` and
`list_admission_policies`. These tools list live names and the exact
`metadata.annotations["kubernetes.io/description"]` value (`null` when absent).
`list_storage_classes` also returns structured storage settings from the live
StorageClass: `provisioner`, `filesystemType`, `parameters`, `reclaimPolicy`,
`volumeBindingMode`, `allowVolumeExpansion`, `isDefault`, `mountOptions`, and
`allowedTopologies`. Driver parameters preserve knobs such as ZFS `recordsize`,
`compression`, `dedup`, and `poolname`. `filesystemType` is normalized from
`csi.storage.k8s.io/fstype`, `fsType`, or `fstype`, in that order; it is `null`
when unspecified. Descriptions are never parsed to infer storage settings or
replica counts. The default-class flag reads the stable or legacy Kubernetes
annotation. Expansion is enabled only when the API field is explicitly true.
Absent parameter maps and option lists are empty, and unspecified provisioner,
reclaim policy, and binding mode are `null`.

Admission policies are returned as CSV with names, descriptions, kinds, target
resource rules/selectors, binding restrictions and a conditional flag. Policy
code, CEL expressions, variables, mutations and parameter objects are never
returned. Targets identify candidate resources; conditions and parameters are
not evaluated. Binding discovery distinguishes `none` from `unavailable`.
Unsupported policy APIs are listed separately; failed reads remain errors.

These catalogs are available to authenticated callers as cluster-wide capability
metadata, without namespace claims or per-user access reviews. Only metrics and
logs use the per-user RBAC checks below. The service account needs `list` on
`storageclasses`, `validatingadmissionpolicies`, `mutatingadmissionpolicies`,
`validatingadmissionpolicybindings`, and `mutatingadmissionpolicybindings`,
as granted by the included RBAC manifest. Catalogs are always registered and do not require monitoring URLs or
`OBSERVABILITY_ENABLED`. Kubernetes configuration lives in its own `kubernetes`
section; API requests use `KUBERNETES_TIMEOUT_MS` (default 10000), independently
of `OBSERVABILITY_TIMEOUT_MS`. Credentials are loaded when a tool is called.

These tools require authenticated HTTP with OIDC. They work without
driftmower-be, driftmower-ui, or a namespace ownership claim. Set
`DRIFTMOWER_BE_ENABLED=false` and leave `DRIFTMOWER_UI_PUBLIC_URL` unset for a
Kubernetes-only deployment; no backend service token is then required and
readiness does not contact Driftmower. The drift-analysis tools keep their
namespace scoping (see [Tenancy](#tenancy)).

```bash
DRIFTMOWER_MCP_TRANSPORT=http
OIDC_ISSUER=https://auth.example/
MCP_PUBLIC_URL=https://mcp.example
DRIFTMOWER_BE_ENABLED=false

# Service addresses verified in ee-lte-1, monitoring namespace:
PROMETHEUS_URL=http://prometheus-operated.monitoring.svc.cluster.local:9090
LOKI_URL=http://loki.monitoring.svc.cluster.local:3100

# Optional; defaults shown:
KUBERNETES_API_URL=https://kubernetes.default.svc
KUBERNETES_TOKEN_FILE=/var/run/secrets/kubernetes.io/serviceaccount/token
KUBERNETES_CA_FILE=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
MCP_SCOPE_SOURCE=union
MCP_SCOPE_MAX_NAMESPACES=2000
MCP_SAR_CACHE_TTL_MS=3600000
MCP_RBAC_WATCH_ENABLED=true
MCP_INVALIDATE_TOKEN=                        # enables POST /api/cache/invalidate with this bearer secret
MCP_INVALIDATE_ALLOWED_SUBJECTS=             # ServiceAccount usernames accepted via TokenReview
KUBERNETES_USERNAME_CLAIM=sub
KUBERNETES_GROUPS_CLAIM=groups
KUBERNETES_USERNAME_PREFIX=${OIDC_ISSUER}#   # '' when the username claim is email; '-' disables
KUBERNETES_GROUPS_PREFIX=
KUBERNETES_TIMEOUT_MS=10000
OBSERVABILITY_TIMEOUT_MS=10000
```

Setting either service URL enables observability. `query_metrics` is registered
only when `PROMETHEUS_URL` is set. `query_logs` uses Loki when `LOKI_URL` is set;
when it is unset, it reads pod logs through Kubernetes instead. A configured
Loki failure is returned to the caller and never switches sources. Set
`OBSERVABILITY_ENABLED=true` to enable Kubernetes-only logs when both URLs are
unset. Loki in ee-lte-1 has `auth_enabled: false`, and Alloy supplies the
`namespace`, `pod`, and `container` labels used by the queries.

Every call requires a named namespace and a successful Kubernetes
[SubjectAccessReview](https://kubernetes.io/docs/reference/access-authn-authz/authorization/#checking-api-access):

| Tool | Permission reviewed for the authenticated caller |
| --- | --- |
| `query_metrics` | `list` core `pods` in the requested namespace |
| `query_logs` (either source) | `get` core `pods/log` for the named pod in the requested namespace |

These permissions are the gateway's policy for accessing namespace-labelled
metrics and pod logs. Kubernetes does not authorize PromQL/LogQL itself.
Namespace claims do not grant or bypass access to these tools. Users need
namespace RoleBindings granting the permissions above; cluster-wide readers and
admins can query any namespace their RBAC permits, but still name one per call.
Missing identity, denied/inconclusive reviews, and API failures fail closed.

The service account in [observability-rbac.yaml](manifests/templates/observability-rbac.yaml)
can list capability catalogs, create access reviews and get pod logs. It cannot impersonate users, read
secrets, or modify workloads. Skaffold renders `manifests/` as a Helm chart and
applies it with kubectl; it does not install a Helm release. The selected namespace
(`--namespace` or the kubeconfig context namespace) is used for every app resource
and the ClusterRoleBinding's service-account subject. No app namespace is baked
into the templates. The service-account
log permission enables the Kubernetes source; the caller's access is checked
before each read. A Loki-only installation can remove that log permission.
This manifest grants the server its permissions, not users theirs.

Reviews are sent as the Kubernetes subject the cluster's own OIDC
authenticator would derive from the verified token. The mapping mirrors the
kube-apiserver flags and must match them: `KUBERNETES_USERNAME_CLAIM`
(`--oidc-username-claim`, default `sub`), `KUBERNETES_USERNAME_PREFIX`
(`--oidc-username-prefix`, default `${OIDC_ISSUER}#`, or empty when the
username claim is `email`, exactly as the apiserver defaults; `-` disables it),
`KUBERNETES_GROUPS_CLAIM` (`--oidc-groups-claim`, default `groups`) and
`KUBERNETES_GROUPS_PREFIX` (`--oidc-groups-prefix`, default empty). The
defaults match the ee-lte-1 bootstrap configuration. A cluster using structured
`AuthenticationConfiguration` with CEL expressions must express its effective
mapping as claim plus prefix here. An unverified `email` username is refused,
as the apiserver refuses it. The MCP bearer token is verified
for the MCP audience; it is never forwarded to the Kubernetes API, Prometheus,
or Loki. The server uses its own mounted token and CA for reviews and log reads,
and reloads the token for rotation.

Example tool arguments:

```json
{
  "namespace": "my-team",
  "metric": "container_cpu_usage_seconds_total",
  "operation": "rate",
  "windowSeconds": 300,
  "aggregate": "sum",
  "groupBy": ["pod"],
  "start": "2026-09-25T10:00:00Z",
  "end": "2026-09-25T11:00:00Z",
  "stepSeconds": 60
}
```

```json
{"namespace":"my-team","pod":"api-7b8c9d","container":"api","contains":"error","limit":100}
```

Metrics support an exact metric name and exact `labels`, optional `rate` or
`increase`, and `sum`, `avg`, `min`, `max`, or `count` aggregation. Without
start/end the query is instantaneous. Every selector includes an immutable
namespace matcher; aggregates retain that label. Arbitrary PromQL/LogQL is not
accepted, so expressions cannot introduce an unscoped selector. The underlying
metrics must have a trustworthy `namespace` label. Results outside the requested
scope are rejected.

Logs default to the past hour, newest first. The Kubernetes source returns only
retained logs from the current container instance, capped at the latest requested
lines and 1 MiB before time/text filtering. Historical queries can be incomplete;
deleted pods and archived logs require Loki. Specify a container for pods with
multiple containers. Both tools cap ranges at seven days, limits at 1,000, and
upstream responses at 4 MiB. Prometheus ranges allow at most 11,000 step intervals.

## Authentication configuration

`MCP_AUDIENCE` must **not** equal driftmower-be's `OIDC_AUDIENCE`
(`https://driftmower-api`). Strict audience checking is what stops an ordinary
browser session token from opening this server, so the two are deliberately
different resource indicators.

With `DRIFTMOWER_MCP_TRANSPORT=http` and `MCP_AUTH_ENABLED` unset (default
`true`), the server refuses to start without `OIDC_ISSUER`. That is intentional:
an HTTP server on an ingress should fail loudly rather than serve open.

The backend URL can also be passed with `--backend-url`:

```bash
driftmower-mcp --backend-url http://127.0.0.1:3030
```

The service token has no CLI flag: a credential on the command line is visible
to every process on the machine.

`DRIFTMOWER_BE_SERVICE_TOKEN` must be a token driftmower-be lists in
`auth.serviceTokens` (it authenticates as a service principal, which is exempt
from the backend's own tenancy scoping — this server scopes what it returns
itself).

## Run

For local MCP clients, use the default `stdio` transport:

```bash
DRIFTMOWER_BE_SERVICE_TOKEN=dm_svc_... npm run start -- --backend-url http://127.0.0.1:3030
```

For HTTP testing:

```bash
DRIFTMOWER_MCP_TRANSPORT=http DRIFTMOWER_BE_SERVICE_TOKEN=dm_svc_... \
  npm run start -- --backend-url http://127.0.0.1:3030
```

HTTP mode exposes:

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Public guidance document: `GET /` renders usage instructions, a Zen of Kubernetes,
  and all bundled engineering advisory Markdown in one page. Advisory references
  jump to sections within the document.
  `HEAD /` returns the same headers without a body. MCP authentication still applies
  to `/mcp`; viewing the guidance requires no sign-in.
- Protected-resource metadata (RFC 9728, unauthenticated):
  `http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp`
- Liveness: `http://127.0.0.1:3001/healthz`
- Readiness: `http://127.0.0.1:3001/readyz`
- Startup: `http://127.0.0.1:3001/startupz`
- Prometheus metrics: `http://127.0.0.1:3001/metrics`

Port 3000 is published through the Ingress; port 3001 stays cluster-internal.
Readiness and startup return 503 until the MCP listener has started; they never
query backing services. Unexpected startup failures close the health listener
and exit nonzero. SIGTERM marks the application unready, stops new connections,
drains requests for up to 20 seconds, then closes remaining streams. A 25-second
process deadline fits within the 30-second container termination grace period.

Metrics report HTTP request counts, open requests/streams, latency (including
stream lifetime), response bytes, declared request sizes when Content-Length is
present, and initialized MCP sessions. Route and method labels use bounded
allowlists; URLs, credentials, namespaces and user identities are not labels.
The chart creates a PodMonitor when the `monitoring.coreos.com/v1/PodMonitor`
API is available. Scrape path, interval, timeout and scheme are left to operator
defaults or cluster admission policies. For offline Helm rendering, pass
`--api-versions monitoring.coreos.com/v1/PodMonitor` to include it.

## Local Codex MCP Registration

For local Codex usage, register this server as a `stdio` MCP server. Pass
`NODE_CONFIG_DIR` explicitly so the server can load this project's
`config/default.json` even when Codex starts it from another working directory.

Build first:

```bash
npm run build
```

Register the server:

```bash
DRIFTMOWER_MCP_DIR=/path/to/driftmower-mcp
DRIFTMOWER_BE_URL=http://127.0.0.1:3030

codex mcp add driftmower \
  --env NODE_CONFIG_DIR="$DRIFTMOWER_MCP_DIR/config" \
  --env DRIFTMOWER_BE_SERVICE_TOKEN="dm_svc_..." \
  -- \
  node "$DRIFTMOWER_MCP_DIR/dist/index.js" \
  --backend-url "$DRIFTMOWER_BE_URL"
```

Check the registration:

```bash
codex mcp list
codex mcp get driftmower
```

Then start Codex in the repository you want to inspect or update:

```bash
codex -C /path/to/your/repository
```

Example prompt:

```text
Ask Driftmower for workloads matching memelord. Based on the snapshot data, inspect this repo and propose the config changes needed to update outdated images.
```

You can also register a running HTTP server instead of `stdio`:

```bash
codex mcp add driftmower-http --url http://127.0.0.1:3000/mcp
```

For local machine usage, `stdio` is the recommended mode. It does not require a
separate long-running server process.

## Docker Usage

Build a local image:

```bash
docker build -t driftmower-mcp:local .
```

Run HTTP mode against a backend:

```bash
docker run --rm \
  -e DRIFTMOWER_MCP_TRANSPORT=http \
  -e DRIFTMOWER_BE_URL=http://driftmower-be:3030 \
  -e DRIFTMOWER_BE_SERVICE_TOKEN=dm_svc_... \
  -p 3000:3000 \
  -p 3001:3001 \
  driftmower-mcp:local
```

Check readiness:

```bash
curl http://127.0.0.1:3001/readyz
```

## Kubernetes Deployment

Kubernetes manifests live in `manifests/`. They deploy the MCP server in HTTP
mode as an internal `ClusterIP` service in the selected release namespace.
Namespaces must already exist and remain outside application release ownership.
The former `manifests/namespace.yaml` was removed after checking ee-west-1's
`driftmowers` namespace: no Helm, Argo CD, Flux or Skaffold tracking metadata,
no Helm release in the namespace, and no Argo CD Namespace inventory entry.
The live namespace was not changed or deleted. For other clusters, inspect
ownership and release inventories before migrating an existing declaration.

The deployment reads from driftmower-be over the cluster network, so it needs
no volume, no pod affinity and no particular node. The in-cluster HTTP server
binds to `::` so Kubernetes can probe it in IPv6 or dual-stack clusters.

The pod reads its service token from the Secret `driftmower-mcp-be-auth-token`
(key `token`), which no manifest creates: a credential does not belong in the
repository. Mint one and register it with driftmower-be before the first
apply — the deployment stays in `CreateContainerConfigError` until the Secret
exists. Backend authentication errors surface when drift tools are called.

```bash
# The raw token is what this server sends; driftmower-be only ever holds its
# SHA-256, listed in its auth.serviceTokens (AUTH_SERVICE_TOKENS) as
# {"serviceName":"driftmower-mcp","tokenHash":"<hash>"}.
DRIFTMOWER_MCP_TOKEN="dm_svc_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
DRIFTMOWER_MCP_TOKEN_HASH="$(printf %s "$DRIFTMOWER_MCP_TOKEN" | sha256sum | awk '{print $1}')"

kubectl create secret generic driftmower-mcp-be-auth-token \
  -n driftmowers \
  --from-literal=token="$DRIFTMOWER_MCP_TOKEN"
```

Deploy to an existing namespace selected by Skaffold:

```bash
skaffold run --namespace kube-system
```

Forward the in-cluster MCP and health endpoints to your local machine:

```bash
kubectl -n driftmowers port-forward deploy/driftmower-mcp 3000:3000 3001:3001
```

After forwarding, Codex can use `http://127.0.0.1:3000/mcp` and readiness is
available at `http://127.0.0.1:3001/readyz`.

The Ingress, its certificate and the OIDC client are in `manifests/templates/ingress.yaml`,
`manifests/templates/certificate.yaml` and `manifests/templates/oidcclient.yaml`. See
**Authentication** below before changing any of them.

## Skaffold Quickstart

Build and deploy with Skaffold:

```bash
skaffold run --tail --port-forward=user
```

For iterative development:

```bash
skaffold dev --port-forward
```

The Skaffold artifact is named `driftmower-mcp`. Configure the registry used
for each Kubernetes context once:

```bash
skaffold config set default-repo zot.ee-lte-1.codemowers.io/codemowers \
  --kube-context admin@ee-lte-1.codemowers.io
skaffold config set default-repo git.codemowers.io/laurivosandi \
  --kube-context admin@ee-west-1.codemowers.io
```

These settings are stored in `~/.skaffold/config` under `kubeContexts`:

```yaml
kubeContexts:
  - kube-context: admin@ee-lte-1.codemowers.io
    default-repo: zot.ee-lte-1.codemowers.io/codemowers
  - kube-context: admin@ee-west-1.codemowers.io
    default-repo: git.codemowers.io/laurivosandi
```

Skaffold uses the selected kubeconfig context, or an explicit `--kube-context`,
to expand the artifact into that context's repository. It renders the Helm chart
with the built image reference and port-forwards MCP to `localhost:3000` and
health endpoints to `localhost:3001`. For example:

```bash
skaffold dev --kube-context admin@ee-lte-1.codemowers.io --namespace kube-system --port-forward
```

Direct Helm deployments default to `ghcr.io/codemowers/driftmower-mcp:latest`.
GitHub Actions publishes that production image after unit and Compose smoke
tests pass. Skaffold development builds use the configured context repository.

The chart's optional `cluster.id` and `cluster.apiUrl` values supply fallback
identity when runtime cluster discovery is unavailable; leave them empty to
rely on discovery.


## Authentication

The HTTP transport is a pure OIDC resource server. It verifies RS256 JWT access
tokens issued by passmower against its JWKS endpoint, checking `iss` and — 
strictly — `aud`. It never mints tokens.

The `aud` it expects is the `resource` it advertises in its protected-resource
metadata, `MCP_PUBLIC_URL` + `/mcp`. That is the only indicator a conformant
client can ask for — it reads the document and passes `resource` verbatim, and
passmower's `resourceIndicators` feature puts that same string in `aud` — so
`MCP_AUDIENCE` is left unset. Set it only to follow something upstream minting
for a different indicator; get it wrong and OAuth completes and every call 401s.

An MCP client is not a browser, which is why the gate is in-process rather than
an oauth2-proxy at the ingress: a cookie/redirect flow cannot be completed by a
headless client, and it would strip the caller identity the tools need to scope
results.

Every 401 carries the pointer a client needs to discover the flow:

```
WWW-Authenticate: Bearer error="invalid_token", error_description="...",
                  resource_metadata="https://driftmower-mcp.ee-lte-1.codemowers.io/.well-known/oauth-protected-resource/mcp"
```

### Connecting a client

**Quick start — paste a token.** Sign in to driftmower-ui and fetch
`/api/mcp/token`; it returns a ready-made `claude mcp add` line. Requires
`MCP_ENABLED=true` on driftmower-ui.

```bash
claude mcp add --transport http driftmower \
  https://driftmower-mcp.ee-lte-1.codemowers.io/mcp \
  --header "Authorization: Bearer <token>"
```

**The token expires in about an hour.** passmower issues no longer-lived access
token, so this is for trying it out, not for a client you intend to keep.

**Durable — OAuth with PKCE.** `manifests/templates/oidcclient.yaml` registers a public
`driftmower-mcp` client. A client that lets you supply a client id does PKCE and
refreshes itself:

```bash
claude mcp add --transport http driftmower \
  https://driftmower-mcp.ee-lte-1.codemowers.io/mcp \
  --client-id kube-system.driftmower-mcp
```

**Pass the client id.** Without it a client falls back to whatever it uses when
dynamic registration is unavailable, and passmower answers `invalid_client`.
Pointing it at the wrong client — `kube-system.driftmower-ui`, say — gets
`invalid_redirect_uri` instead: that one is a confidential `web` client whose
only registered URI is an https callback, so no loopback redirect can match it.
The two errors are how you tell which mistake you made.

**Known limitation.** passmower has **no dynamic client registration**
(`features.registration` is absent from its `src/configuration.js`), so a strict
DCR-only client will not connect even with perfect metadata. `features.deviceFlow`
is enabled as a headless fallback.

Redirect URIs are enumerated in the OIDCClient CR. Because it is registered as
`applicationType: native`, oidc-provider ignores the **port** of an http
loopback redirect URI, so a client picking a random port still matches. The
**hostname** is not normalised, so `localhost`, `127.0.0.1` and `[::1]` are all
registered; the **path** must match exactly, and a client wanting something
other than `/callback` needs it added.

`scopes_supported` in the metadata includes `offline_access`, which is what gets
a client a refresh token — a client requests exactly what is advertised, and
without it the connection stops working an hour after every sign-in.

### Tenancy

Results are confined to the namespaces a caller may see, decided by
`MCP_SCOPE_SOURCE`:

- `union` (default): the namespaces in the token's `codemowers.io/namespaces`
  claim (put there by the `namespaces` OIDC scope on clusters running
  platform-manager) plus every namespace where the cluster authorizer lets the
  caller `list` pods, discovered with the same SubjectAccessReview sweep as
  `list_accessible_namespaces`. An absent claim contributes nothing; an
  authorizer that cannot be asked contributes nothing and the response says so.
  On a cluster without platform-manager the claim is simply absent and RBAC
  alone decides. The two are grants: neither removes what the other allows, and
  every read still asks the cluster.
- `claim`: the token claim alone, today's behaviour before RBAC discovery. A
  token carrying no claim gets no access, not full access. This also skips the
  sweep entirely, which is the setting for a very large cluster where the sweep
  shows up in `subjectaccessreviews` metrics.
- `rbac`: the authorizer alone; the claim is ignored.

`search_workloads` and `plan_image_updates` filter on
`image_usages.workload_namespace`. A Helm release whose workloads all fall
outside the caller's scope disappears rather than leaking its name. The
provisioning tools ask the cluster authorizer per namespace instead: a
namespace where the caller may not list pods is withheld, and every
permission verdict is a SubjectAccessReview as the verified caller.

Every response carries a `scope` notice saying whether tenancy limited it, so an
empty result is never ambiguous between "nothing is there" and "not yours to
see". The notice distinguishes a claim-less token, an authorizer that granted
nothing (naming the mapped Kubernetes identity, since a wrong
`KUBERNETES_USERNAME_CLAIM`/`KUBERNETES_USERNAME_PREFIX` looks the same to the
apiserver as a user with no access), and an authorizer that could not be
evaluated. A caller who may list pods cluster-wide is unscoped.

At startup on the HTTP transport the server sends one SubjectAccessReview for
a synthetic user and logs whether the authorizer answers; a warning here means
every RBAC-derived answer will be `unknown` until the service account may
create `subjectaccessreviews`.

On `stdio` there is no authentication and no scoping: it is a local process
reading a local database, with no network surface.

## Tools

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: false`. Nothing here writes.

Every tool returns both forms: a short text summary written for a human reading
a chat, and `structuredContent` an agent can branch on, validated against the
tool's declared output schema. The text block summarises — it is deliberately
not a JSON copy of the structured payload, which would spend the reader's
context twice for the same facts.

### `search_workloads`

`search_workloads` accepts:

```json
{
  "query": "memelord",
  "limit": 20
}
```

Results include workload identity, cluster, namespace, kind, observed image or
Helm version details, latest known versions when available, and snapshot
metadata. The response represents analyzed snapshot data, not guaranteed live
cluster state.

### `plan_image_updates`

`plan_image_updates` returns an advisory, paginated update plan from the latest
ready in-cluster, all-namespace report. Cluster selection is implicit because an
MCP deployment is paired with one Driftmower backend. Later pages remain pinned
to the first page's snapshot.

```json
{
  "namespace": "cert-manager",
  "versionStatuses": ["major_behind", "minor_behind", "patch_behind"],
  "limit": 20
}
```

All input fields are optional. `namespace` and `versionStatuses` filter actions,
`limit` bounds a page, and `cursor` continues a previous page. The tool does not
accept a cluster selector and ignores reports produced from external kubeconfig
contexts.
The supported version statuses are `major_behind`, `minor_behind`,
`patch_behind`, and `behind`. Use the returned `nextCursor` unchanged to request
the next page with the same filters.

An abbreviated result looks like:

```json
{
  "status": "ok",
  "snapshot": {
    "reportId": "0b249694-625d-41c8-a788-5b207c9c4d6b",
    "createdAt": "2026-07-13 20:14:51"
  },
  "summary": {
    "uniqueImageCandidates": 3,
    "totalActions": 1,
    "imageTagUpdates": 0,
    "helmChartUpdates": 1,
    "manualReviews": 0
  },
  "actions": [
    {
      "type": "helm_chart_update",
      "releaseName": "cert-manager",
      "observedChartVersion": "v1.20.0",
      "latestKnownChartVersion": "1.21.0"
    }
  ],
  "nextCursor": null,
  "warnings": ["This plan is based on a Driftmower analysis snapshot, not live cluster state."]
}
```

Actions are one of:

- `image_tag_update` for a non-Helm workload and container.
- `helm_chart_update` for a Helm release with a distinct chart candidate.
- `manual_review` when a Helm release has no usable distinct chart candidate.

Helm actions include at most ten deduplicated image evidence records. Raw report
payloads and chart-tag candidate arrays are not exposed. The tool is read-only,
and its results do not establish compatibility, maintenance approval, or
deployment safety. Repository discovery, edits, validation, and approval remain
the caller's responsibility.


## Provisioning Tools

All provisioning tools read Kubernetes directly with the server's own service
account and are always registered. Every fact is discovered from the cluster:
an optional component that is absent (an admission guard, cert-manager,
Cilium, Kyverno, an operator) degrades one fact rather than the answer, and
nothing assumes a particular platform is installed. Every permission answer is
a SubjectAccessReview sent as the verified caller; no Role or RoleBinding is
ever read or interpreted, so the answer is exact for any authorizer. An
unauthenticated call (stdio, `MCP_AUTH_ENABLED=false`) still gets every fact,
with permission verdicts reported as `unknown` rather than refused.

### `describe_cluster_capabilities`

No arguments. Requires an authenticated caller, like the shared cluster catalogs.
Returns CSV catalogs: CRD names and descriptions, issuer names and descriptions,
ingress classes and priority classes. No schemas, resource status, readiness or
duplicate API-family inventories are included. Missing optional catalogs are
marked unavailable, with discovery errors reported separately. CRD read failures
fail the tool. Use `get_cluster_identity` for connection identity.

### `describe_custom_resource_definition`

Accepts `name`, the full CRD name from the capability catalog (for example
`clusters.postgresql.cnpg.io`). Returns structured JSON containing its name,
description, group, kind, resource, scope and served-version schemas. Status
properties, status requirements, controller metadata and CEL validation code
are omitted. This is a provisioning schema, not an unmodified CRD export.

### `describe_provisioning_platform`

No arguments. The interpreted counterpart of `describe_cluster_capabilities`:
storage classes with what each implies for data (node-local, zonal,
cluster-wide; expandable; retained), zones and schedulable nodes, priority
classes, the published ingress domain and where it came from (an enforced
ingress guard's own parameter ConfigMap, or `PROVISIONING_INGRESS_DOMAIN_SUFFIX`),
TLS advice, enforced ValidatingAdmissionPolicies and the namespace label they
scope tenancy on, Kyverno policies, the network policy engine and whether the
Prometheus operator is present.

### `list_offerings`

Every offering the platform can provision, with availability and, when it is
unavailable, why. Optional `offering` narrows to one. Optional `namespace`
adds `mayCreate` per offering: whether the caller may create every resource
the offering's sample manifest creates there, with enforced admission
policies considered.

### `describe_namespace_readiness`

Takes `namespaces` (1 to `PROVISIONING_MAX_NAMESPACES`) and an optional
`offering`. Per namespace: quota used/hard/free, LimitRange defaults, network
posture, Pod Security enforcement, the tenant label and id an enforced guard
scopes on, the hostnames the namespace may claim (only when a guard enforces
a pattern; otherwise an honest note), any policy that selects on an **exact
instance name**, and the caller's access there.

Access is an **access matrix**: one SubjectAccessReview per namespaced
resource type the cluster serves (kube primitives and every CRD) for each of
the eight standard verbs, built lazily on first request and served from the
review cache afterwards. The prose summarises it (counts per verb; view, edit
and admin; a verdict per offering naming the blocking resource); the full
matrix is in the structured content. A cold build is roughly eight reviews
per resource type, well under a second in-cluster.

Namespaces where the caller may not list pods come back in `withheld`, and
an inconclusive review is reported under `degraded`; neither reads as empty.

### `check_access`

Takes `verb`, `resource`, optional `group`, `namespace`, `subresource` and
`name`. One exact review as the verified caller, for anything the matrix does
not cover: cluster-scoped resources, subresources such as `pods/log`, named
objects, `proxy`, and any resource outside the offering catalog (Strimzi,
Crunchy, whatever the cluster serves). Enforced admission policies that
govern create, update or delete on the resource are reported alongside and
outrank an RBAC yes.

### `GET /api/provisioning/capabilities`

The same capability layer as plain JSON, on the MCP port beside `/mcp`, for
driftmower-ui and any consumer that is not an MCP client. Query `ns` (comma
separated, at most `PROVISIONING_MAX_NAMESPACES`) and `offering`. It is
verified by the same bearer authenticator and audience as `/mcp`, so the UI
mints a token for this server (its `/api/mcp/token` route) rather than
forwarding a session token. Responses are `Cache-Control: no-store`; errors
are JSON with an RFC 6750 challenge on 401.

### Facts that could not be read

A fact the capability layer could not read arrives as a `degraded` entry and is
rendered under "Facts that could not be read", never as an absent or passing
one. A refused read that looks like an empty result is the single failure mode
this layer exists to prevent. The service account needs the read-only rules in
[observability-rbac.yaml](manifests/templates/observability-rbac.yaml): nodes,
deployments, resourcequotas, limitranges, networkpolicies, ciliumnetworkpolicies,
kyverno clusterpolicies and `get` on ConfigMaps (narrow it with the Helm value
`rbac.paramConfigMapNames`), on top of the catalogs and `subjectaccessreviews`.

## Development

Prefer Docker Compose or Skaffold for development, builds and tests. Do not
install host components for a coding agent. Dependency manifests and lockfiles
can be edited directly, including lockfile-only package-manager commands.

```bash
docker compose up --build -d
docker compose run --build --rm test
docker compose down
```

Compose runs a hot-reloading MCP service and a separate fixture-backed HTTP
service named `driftmower-be`. Ports 3000 and 3001 bind only to localhost;
authentication is disabled only for this local setup. The fixture token is
public test data. This setup exercises MCP, HTTP backend integration, and metrics;
it does not simulate production OIDC, Kubernetes authorization, or operators.
Use real configured dependencies to validate those integrations.

The development image uses the same pinned Node version and lockfile as
production. Source and test bind mounts enable hot reload and container-based
checks; dependencies remain in the image. Rebuild after changing the lockfile.
Set `LOCAL_UID` and `LOCAL_GID` if your host identity differs from 1000.
The test service runs typecheck, lint, build, all tests, and an MCP smoke test
against the Compose services. For checks without starting dependencies:

```bash
docker compose run --build --rm --no-deps test npm test
```

```bash
docker compose run --rm --no-deps test npm run format
docker compose run --rm --no-deps test npm run typecheck
docker compose run --rm --no-deps test npm run build
docker compose run --rm --no-deps test npm test
```

The test suite includes repository tests, service tests, MCP transport tests, and
fixture-backed integration coverage: `test/fixtures/backend/` holds rows
recorded from a real full-cluster analysis, and `test/fake-backend.ts` serves
them over the same HTTP path production uses, rejecting any query the real
backend's schemas would reject.
