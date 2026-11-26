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

### CA certificates

Driftmower's images are built `FROM scratch` and contain no CA certificates.
The cluster must give its Pods a CA bundle; Driftmower makes outbound HTTPS
requests to the OIDC issuer (to verify logins), GitHub and other source
hosts, and container registries. Without one, every login fails with
`x509: certificate signed by unknown authority`.

The codemowers platform provides this with trust-manager, which distributes a
`trusted-ca-certs` ConfigMap to namespaces, and the `workload-trusted-ca`
admission policy, which mounts it at `/etc/ssl/certs/ca.pem` and sets
`SSL_CERT_FILE`. Clusters without that layer, such as a plain Talos Linux
installation (Talos does not share its host trust store with Pods), can name an
existing ConfigMap in the release namespace that holds a PEM bundle:

```yaml
trustedCA:
  configMapName: ca-bundle   # in the release namespace
  key: ca.pem                # default
```

Every Driftmower workload then mounts it at the same path with
`SSL_CERT_FILE`, which the platform policy leaves untouched where both exist.
Include internal CAs if the OIDC issuer or a registry uses one.

A cluster can adopt the platform's approach in steps. The reusable layer is
cert-manager, trust-manager and a `Bundle` named `trusted-ca-certs` that
publishes the public CAs to every namespace:

```bash
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version 1.20.0 --namespace cert-manager --create-namespace --set crds.enabled=true
helm upgrade --install trust-manager oci://quay.io/jetstack/charts/trust-manager \
  --version 0.22.0 --namespace cert-manager
kubectl apply -f - <<'EOF'
apiVersion: trust.cert-manager.io/v1alpha1
kind: Bundle
metadata:
  name: trusted-ca-certs
spec:
  sources:
    - useDefaultCAs: true
  target:
    configMap:
      key: ca.pem
    namespaceSelector: {}
EOF
```

Then set `trustedCA.configMapName: trusted-ca-certs`. Other workloads can mount
the same ConfigMap. Adding the platform's `workload-trusted-ca` admission
policy later (it needs the `MutatingAdmissionPolicy` API) injects it into every
Pod and makes the explicit setting redundant. The desktop's one-click install
performs these steps for OIDC installs on clusters whose Pods get no CA bundle,
with cert-manager as an explicit opt-in when it is missing.

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

Add `mcp.portForwardOnly: true` to close the MCP port to the Pod network as well.
Port-forwarded connections arrive on the Pod's loopback and are not filtered by
NetworkPolicy, so reaching this unauthenticated MCP then requires permission to
port-forward to Pods in its namespace rather than mere network access. The
desktop application's one-click install uses exactly these values when a
cluster has no Passmower OIDCClient API. With Passmower it uses the chart
defaults if admission expands the short `mcp`/`dashboard` Ingress hosts, and
otherwise disables `mcp.ingress` and `ui` so MCP is reached by port-forward.
The desktop ignores Ingress hosts without a dot, which only resolve once
expanded, and port-forwards instead.

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

## Scan placement

`operator.trivy.strategy` defaults to `operatorNamespace`, scanning cached images
from the release namespace. Configure `operator.trivy.strategy=workloadNamespace`
when scans require a consuming Pod's namespace-local pull references
(`SCAN_STRATEGY=workloadNamespace` with Skaffold). Set
`operator.trivy.cpuRequest` (`SCAN_CPU_REQUEST` with Skaffold) for the target
cluster; the default is `100m`, with no CPU limit. Keep cluster-specific
overrides in ignored local files under `chart/cluster-values/`.

`workloadNamespace` selects a running Pod by its observed immutable image ID and
runs the scan in that Pod's namespace on the same Node, with its pull Secret
references. Images with no running consumer remain pending. Workload credentials
stay in their original Secrets; no workload ServiceAccount is reused. The
operator creates a scan ServiceAccount without workload permissions and mirrors
only the release's configured scanner image pull Secrets into that namespace.
Mirrors follow credential rotation when dispatching a scan and are owned by the
scan ServiceAccount. A scan-owned egress policy permits DNS and uploads to the
operator, including in namespaces with default-deny rules. Namespace removal
removes these resources; disabling the strategy does
not delete ServiceAccounts or credential mirrors from existing namespaces.

This opt-in strategy grants the operator cluster-wide Pod lifecycle access,
event reads, scan ServiceAccount and NetworkPolicy creation, and infrastructure pull
Secret mirrors. Reads of infrastructure source Secrets stay restricted to the
configured names in the release namespace; mirror reads/updates are restricted
to their deterministic names. Scan Pods retain user namespaces, dropped
capabilities, offline scanning and bounded centralized artifact retention.

## Merged CycloneDX evidence

The scanner publishes a filesystem-only CycloneDX document before starting
Trivy, then replaces that same artifact with the merged vulnerability report.
A failed Trivy step preserves filesystem evidence and marks vulnerability status
as failed. Pending and failed reports never satisfy vulnerability coverage or
suppress scan retries. MCP can project static analysis and download either phase
through the same authenticated artifact store; no analysis sidecar is retained.

File evidence uses bounded `type: file` components: the 1,000 newest regular
files plus bounded ELF and shell observations, deduplicated by path. Standard
`mime-type` carries the base media type. Custom observations use namespaced
properties, including `driftmower:file:modified-at`, `driftmower:elf:linking` and
`driftmower:shell:resolved-path`. BOM-level properties carry filesystem counts,
MIME/linking histograms, coverage limits and
`driftmower:filesystem:latest-modified-at`. The latest path is not duplicated at
the top level. `driftmower:scan:vulnerabilities-status` distinguishes pending,
complete and failed vulnerability steps; existing scan coverage/database
properties retain their meanings.

ContainerImage labels and config JSON creation time stay in their independent
metadata lifecycle. The UI combines them with filesystem timestamps: created
label first, config time second, latest file modification as an explicit estimate.
A warning triangle exposes secondary facts when timestamps differ by an hour.
