# Deployment and access

[Driftmower](../README.md)

## Install the chart

Create the namespace and choose the authentication, ingress, monitoring and storage settings
for the target cluster before installing. The version below is an example; use the
release version you intend to install.

```bash
helm upgrade --install driftmower oci://ghcr.io/codemowers/charts/driftmower \
  --version 0.9.0 --namespace driftmower -f values.yaml
```

Deployment manifests live in [chart/](../chart/). Skaffold renders the whole chart
in one deployment. Application resources and references follow the release
name; cluster-scoped identities also include the namespace. Each cluster has one Driftmower installation; its MCP Service is named `mcp`.

The dashboard reads its MCP endpoint from the MCP OIDC owner Secret.
Short dashboard/MCP hostnames rely on cluster admission expansion.
Image scanning and source discovery require the image inventory CRDs supplied by
nodestatd. OIDC modes require the Passmower OIDCClient API and its controller.
Prometheus integration uses the installed Prometheus Operator APIs. Each component can be disabled with its `enabled`
value. Set `history.storageClassName` to select storage explicitly; otherwise
the cluster default is used. Namespace lifecycle belongs to the platform.

Trivy CycloneDX results live on the operator StatefulSet's
`sboms-<release>-operator-0` PVC mounted at `/cache`, so operator Pod replacements
preserve scan results. Configure
`operator.sbomStorageClassName` for the target cluster; unset uses its default
storage class. `operator.sbomCacheMiB` bounds the cache (2048 MiB by default),
and the claim requests an additional 64 MiB of headroom. Old results may still
be evicted; this is a regenerable cache, not a permanent scan archive. The
Skaffold configuration selects `scratch` for a retained claim that survives
Pod and StatefulSet deletion, and excludes the claim from Skaffold cleanup.
When migrating an existing installation, stop and remove its operator Deployment
before starting the StatefulSet; its old emptyDir cache must be regenerated.
On a cluster where `scratch` is TopoLVM, this is
node-local TopoLVM storage; it survives Pod replacement, not loss of its node.

## Access modes

`mcp.auth.mode` selects the access policy:

| Mode | Login | Read access | Mutation tools |
| --- | --- | --- | --- |
| `rbac` (default) | OIDC | Verified caller's Kubernetes RBAC | Existing feature flags and caller RBAC |
| `oidc` | OIDC | All namespaces, without caller RBAC checks | Disabled |
| `anonymous` | None | Anyone who can reach MCP can read all namespaces | Disabled |

OIDC-only still verifies issuer, audience and expiration and binds sessions to
one verified subject. It does not require a Kubernetes username/group mapping.
The relaxed modes ignore namespace claims. The MCP ServiceAccount still needs
Kubernetes permission to fetch the data. Permission guidance in these read-only
modes reports writes denied rather than promising Kubernetes write privileges.

Anonymous mode renders no MCP/UI OIDCClient or owner-Secret references. For a
cluster without Passmower or Ingress, deploy MCP alone using these values:

```yaml
mcp:
  auth:
    mode: anonymous
  ingress:
    enabled: false
  publicUrl: http://127.0.0.1:3000
  dashboard:
    localOrigins: ["http://localhost:17843"]
ui:
  enabled: false
operator:
  enabled: false
crawler:
  enabled: false
registryScraper:
  enabled: false
```

Configure `mcp.dashboard.localOrigins` to include `http://localhost:17843` for
the desktop browser. Start the desktop normally and connect to the admin
certificate context in Settings. It automatically forwards the Service when no
Ingress exists and skips MCP login when the endpoint advertises anonymous mode.

An explicit manual forward remains available for other clients:

```sh
kubectl --context <context> --namespace driftmower port-forward service/mcp 3000:3000
```

To select that manual endpoint explicitly, after `npm --prefix ui run build`:

```sh
MCP_URL=http://127.0.0.1:3000/mcp KUBECTL_CONTEXT=<context> \
  ASSET_DIR=ui/static/out go run ./desktop
```

Skaffold maps `MCP_AUTH_MODE`, `MCP_INGRESS_ENABLED` and `MCP_PUBLIC_URL` to the
matching Helm values. Keep cluster-specific choices in local `skaffold.env.*`.

## Per-cluster components

Crawler and registry scraper instances are private to each cluster. Their HTTP
APIs use projected ServiceAccount credentials; browsers and agents reach them
through that cluster’s MCP. Image promotion also copies the crawler GitHub
Secret to each destination. There are no shared public catalog endpoints.
