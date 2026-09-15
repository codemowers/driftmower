# Driftmower MCP

The platform's single MCP gateway. It serves coding agents two things over one
authenticated endpoint:

- **Drift analysis** — persisted Driftmower snapshots read from the
  driftmower-be API (`search_workloads`, `plan_image_updates`).
- **Provisioning capabilities** — what a cluster offers a workload and what will
  bite you, proxied from driftmower-ui's capability layer
  (`describe_cluster_capabilities`, `list_offerings`,
  `describe_namespace_readiness`, `explain_storage_class`).

Everything here is read-only. The server never writes to the backend, the
cluster, or a target repository; the provisioning tools generate knowledge, not
manifests, and nothing in this server applies anything.

Published behind passmower OIDC. Results are scoped to the caller's own
namespaces.

## Requirements

- Node.js 24 or compatible current LTS runtime
- A reachable driftmower-be, and a service token it accepts

The backend must be recent enough to allow `id` and `status` in a `/reports`
query and to allow `$select` of the workload and tag columns on
`/image-usages` (driftmower-be #59 and #82). An older backend answers 400 to
these queries; the readiness probe then reports not ready rather than the
tools failing one call at a time.

## Install

```bash
npm install
npm run build
```

## Configuration

Default configuration lives in `config/default.json` and can be overridden with
environment variables:

```bash
DRIFTMOWER_BE_URL=http://driftmower-be:3030
DRIFTMOWER_BE_SERVICE_TOKEN=dm_svc_...
DRIFTMOWER_BE_TIMEOUT_MS=15000
DRIFTMOWER_MCP_TRANSPORT=stdio
DRIFTMOWER_MCP_HOST=127.0.0.1
DRIFTMOWER_MCP_PORT=3000
DRIFTMOWER_MCP_HEALTH_PORT=3001
DRIFTMOWER_MCP_DEFAULT_LIMIT=20
DRIFTMOWER_MCP_MAX_LIMIT=100
DRIFTMOWER_MCP_LOG_LEVEL=info

# Authentication (HTTP transport only; stdio is a local process and is not gated)
OIDC_ISSUER=https://passmower.example        # matched against the token `iss`
OIDC_JWKS_URI=                               # defaults to ${OIDC_ISSUER}/jwks
MCP_AUDIENCE=https://driftmower-mcp          # verified strictly as `aud`
MCP_PUBLIC_URL=https://driftmower-mcp.ee-lte-1.codemowers.io
MCP_AUTH_ENABLED=true                        # false only for a server no one can reach

# Provisioning tools; unset means they are not registered at all
DRIFTMOWER_UI_URL=http://driftmower-ui
DRIFTMOWER_UI_TIMEOUT_MS=10000
```

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
- Protected-resource metadata (RFC 9728, unauthenticated):
  `http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp`
- Liveness: `http://127.0.0.1:3001/healthz`
- Readiness: `http://127.0.0.1:3001/readyz`
- Startup: `http://127.0.0.1:3001/startupz`

Port 3000 is published through the Ingress; port 3001 stays cluster-internal.

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
  -e DRIFTMOWER_MCP_HOST=0.0.0.0 \
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
mode as an internal `ClusterIP` service in the `driftmowers` namespace.

The deployment reads from driftmower-be over the cluster network, so it needs
no volume, no pod affinity and no particular node. The in-cluster HTTP server
binds to `::` so Kubernetes can probe it in IPv6 or dual-stack clusters.

The pod reads its service token from the Secret `driftmower-mcp-be-auth-token`
(key `token`), which no manifest creates: a credential does not belong in the
repository. Mint one and register it with driftmower-be before the first
apply — the deployment stays in `CreateContainerConfigError` until the Secret
exists, and the pod never becomes ready until the backend accepts the token.

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

Apply manually:

```bash
kubectl apply -f manifests/namespace.yaml
kubectl apply -f manifests/deployment-app.yaml
kubectl apply -f manifests/service.yaml
```

Forward the in-cluster MCP and health endpoints to your local machine:

```bash
kubectl -n driftmowers port-forward deploy/driftmower-mcp 3000:3000 3001:3001
```

After forwarding, Codex can use `http://127.0.0.1:3000/mcp` and readiness is
available at `http://127.0.0.1:3001/readyz`.

The Ingress, its certificate and the OIDC client are in `manifests/ingress.yaml`,
`manifests/certificate.yaml` and `manifests/oidcclient.yaml`. See
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

The Skaffold config builds `git.codemowers.io/uq69adc8851/driftmower-mcp`,
deploys the raw manifests, and port-forwards the MCP endpoint to
`localhost:3000` and health endpoints to `localhost:3001`.


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

**Durable — OAuth with PKCE.** `manifests/oidcclient.yaml` registers a public
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

Results are confined to the namespaces in the caller's `codemowers.io/namespaces`
claim, which the `namespaces` OIDC scope puts into the token.

- `search_workloads` and `plan_image_updates` filter on
  `image_usages.workload_namespace`. A Helm release whose workloads all fall
  outside the caller's scope disappears rather than leaking its name.
- The provisioning tools forward the caller's own token to driftmower-ui, which
  makes the same decision for its Kubernetes reads. A crafted namespace list
  cannot read another sandbox's quota.

Every response carries a `scope` notice saying whether tenancy limited it, so an
empty result is never ambiguous between "nothing is there" and "not yours to
see". **A token carrying no namespaces claim gets no access, not full access** —
failing open would mean that dropping the `namespaces` scope from the OIDCClient
silently hands every caller the whole fleet.

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

These answer "what can I deploy here, and what will bite me". They are a façade
over driftmower-ui's capability layer (`lib/features/provisioning/`), which owns
the Kubernetes reads and the RBAC behind them; this server holds no cluster
credentials of its own. They are registered only when `DRIFTMOWER_UI_URL` is set —
an unconfigured deployment advertises no provisioning tools rather than tools
that always fail.

Each returns prose rather than a one-line summary: these answer questions a
beginner asks, so the text block is several short paragraphs.

### `describe_cluster_capabilities`

Storage classes and what each implies, zones and schedulable nodes, priority
classes, the network-policy engine, per-operator readiness, the ingress domain
and TLS advice, and the ValidatingAdmissionPolicies that override RBAC. No
arguments.

### `list_offerings`

Every offering the platform can provision, with availability and — when it is
unavailable — why ("the dragonfly-operator is not installed on this cluster").
Optional `offering` narrows to one.

### `describe_namespace_readiness`

Takes `namespaces` (1–12). Per namespace: quota used/hard/free, LimitRange
defaults, network posture, Pod Security enforcement, `mayCreate`, the hostnames
the namespace may claim, and any policy that selects on an **exact instance
name** — the trap that makes a database named anything unexpected never report
ready, with no error pointing at the cause.

Namespaces you cannot access come back in `withheld` rather than erroring.

### `explain_storage_class`

Takes `name`. One class in plain language: local to a machine? does a volume pin
its pod to a node? can it grow? does the data survive deleting the instance? On
node-local storage it says so plainly, because "3 replicas" there is not the
high availability the number suggests.

### Facts that could not be read

A fact the capability layer could not read arrives as a `degraded` entry and is
rendered under "Facts that could not be read", never as an absent or passing
one. A refused read that looks like an empty result is the single failure mode
this layer exists to prevent.

## Development

```bash
npm run format
npm run typecheck
npm run build
npm test
```

The test suite includes repository tests, service tests, MCP transport tests, and
fixture-backed integration coverage: `test/fixtures/backend/` holds rows
recorded from a real full-cluster analysis, and `test/fake-backend.ts` serves
them over the same HTTP path production uses, rejecting any query the real
backend's schemas would reject.
