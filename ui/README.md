# Driftmower dashboard

The dashboard is a static browser application served by a small Go binary. It
queries a cluster's Go MCP endpoint directly, including live updates over MCP
subscriptions. Current inventory comes from Kubernetes CRDs and version history
from the dedicated Prometheus instance. No backend database, BFF, or Kubernetes
credentials are required in the dashboard.

## Local dashboard for both clusters

From the repository root:

```sh
docker compose up --build -d
```

Open http://localhost:8080. The cluster selector starts with `ee-lte-1` and
`ee-west-1`; additional HTTPS MCP addresses can be saved in the browser.
Select a cluster and sign in. Switching clusters starts a separate sign-in flow.
Access and refresh tokens stay in memory; only endpoint preferences are stored
in localStorage. The one-time PKCE transaction uses sessionStorage to survive
the authorization redirect.

Compose binds only to 127.0.0.1 and mounts no kubeconfig or credentials. The Go
server serves files and public endpoint configuration; requests go directly from
the browser to the selected cluster. Stop it with `docker compose down`.

Each MCP deployment must allow `http://localhost:8080` (and optionally
`http://127.0.0.1:8080`) in `dashboard.localOrigins`. Its native OIDC client must
allow those CORS origins and `/callback` loopback redirects. The chart configures
both. Local login uses that native public client with PKCE and requests the
selected MCP URL as its resource audience. Cluster-hosted login uses the separate
web client. Arbitrary origins remain rejected.

## In-cluster deployment

The `ui` Skaffold module builds and deploys the static dashboard into the selected
cluster. `MCP_URL` pins it to that cluster and hides the endpoint chooser.
Skaffold's `mcp`, `crawler`, `operator`, and `history` modules deploy the Go
services, scanner and dedicated Prometheus. The node inventory agent and its CRDs
must also be installed; see the sibling `driftmower-agent` repository.

```sh
set -a
source skaffold.env
set +a
skaffold run
```

For ee-west-1, use the `ee-west-1` profile and override the context and registry:

```sh
export SKAFFOLD_KUBE_CONTEXT=admin@ee-west-1.codemowers.io
export SKAFFOLD_NAMESPACE=driftmower
export SKAFFOLD_DEFAULT_REPO=zot.registry.ee-west-1.codemowers.io/<your-user>
skaffold run -p ee-west-1
```

The west profile supplies dashboard/MCP hosts and OIDC redirect URLs without
changing the default ee-lte-1 manifests. Registry credentials for Kaniko use the
`driftmower-kaniko-registry` Secret. Cluster admission supplies image pull secrets
and Prometheus priority; verify those policies exist before deploying.

## Public runtime configuration

- `MCP_URL`: single fixed MCP endpoint; hides cluster selection.
- `MCP_ENDPOINTS`: JSON array of `{ "name": "cluster", "url": "https://host/mcp" }`
  entries to seed the local cluster chooser without overriding saved entries.
- `LISTEN_ADDR`: default `[::]:8080`.
- `ASSET_DIR`: default `/app/public`.

These values are read at runtime, so the same image serves either cluster or the
local Compose dashboard. There are no server-side OAuth secrets.
