# Driftmower MCP

MCP server for exposing persisted Driftmower analysis snapshots to coding agents.

The server reads persisted analysis snapshots from the driftmower-be API and
provides tools for finding workloads and planning image updates. It only ever
reads: it never writes to the backend or to a target repository.

## Requirements

- Node.js 24 or compatible current LTS runtime
- A reachable driftmower-be, and a service token it accepts

The backend must be recent enough to allow `id` and `status` in a `/reports`
query. Without that this server cannot select the fields it needs, and every
report listing would make the backend assemble its full body.

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
```

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
- Liveness: `http://127.0.0.1:3001/healthz`
- Readiness: `http://127.0.0.1:3001/readyz`
- Startup: `http://127.0.0.1:3001/startupz`

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

HTTP mode is intended for internal cluster access only in the MVP. Do not expose
it through Ingress or the public internet without adding authentication and
authorization.

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

## Tools

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
