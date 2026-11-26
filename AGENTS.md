# Repository guidance

Driftmower is cluster infrastructure with one installation per cluster.

## Engineering guidance and cluster access

Use the connected `codemowers` MCP for engineering guidance from
https://mcp.codemowers.io. Read its advisory index and task-relevant sections
before development, build or deployment decisions, including `developing/git`
for local verification and ignore-file review before staging or committing.
If the MCP is unavailable, use the published guidance or the local
`../codemowers-mcp/content/` checkout.

Use the matching `driftmower-*` MCP for target-cluster identity, capabilities,
policies, access, workloads, images and observability. Discover available tools
and verify the selected connection's cluster identity; do not infer capabilities
from another cluster. Prefer these tools over equivalent kubectl/API queries.
When a required operation is unavailable through MCP, use kubectl with an
explicit context matched to the MCP's external Kubernetes API URL in local
kubeconfig, not merely a similar context name. Mutations remain within the
user's requested scope.

## Local verification

`.github/workflows/ci.yml` defines this repository's CI checks. Run Go checks
with the latest patches of both supported CI branches (1.26 and 1.27);
serialization can differ between toolchains. Release builds use the latest
stable Go version; keep Dockerfile pins current. Its Go lint scope is
`./mcp/...`. For monitoring rules, also run
`bash scripts/test-security-rules.sh` with `promtool`. For desktop
build changes, generate the frontend before building with `CGO_ENABLED=0`.
Look for existing tools under the ignored `.build-tmp/` directory as well as
on PATH, and use workspace build scratch space when `/tmp` is too small.

## MCP access modes

`mcp.auth.mode` selects `rbac` (default: OIDC plus caller Kubernetes RBAC),
`oidc` (verified OIDC login grants all reads), or `anonymous` (all reads for
anyone reaching the endpoint, without Passmower). The latter modes disable
mutation tools and ignore token namespace claims. OIDC-only still validates
issuer, audience, expiry and session ownership. Anonymous transport supplies a
fixed `system:anonymous` identity; supplied bearer tokens are ignored. Preserve
the endpoint's explicit mode in browser discovery; never fall back to anonymous
after a failed OIDC verification. Anonymous Helm rendering must not depend on
OIDCClient resources or owner Secrets. `mcp.ingress.enabled=false` supports a
Service-only deployment. Desktop discovery automatically opens a loopback-only
Kubernetes port-forward when no public endpoint exists, using already resolved
credentials; it never invokes kubectl or interactive credential plugins for the
tunnel. Forward ownership follows the API-server/authentication identity, keeping
namespace aliases together and different credentials separate. Reuse working
tunnels, preserve their local port across reconnects/Pod replacement, and close
them when contexts disappear or the desktop exits. OIDC resources/audiences stay
canonical even when their transport endpoint is a discovered local forward.

## Alert ownership

Bundle recording and alert rules consuming Driftmower component metrics with
this chart in `chart/templates/prometheus-rules.yaml`; general platform rules
belong to the platform monitoring repository. Security rules belong to
`driftmower.security.*` groups and ship with their metric producers, not ahead
of them. Annotations must explain the observed condition, units and duration,
impact, concrete next checks, and limits of the evidence. Keep runtime values
in annotations rather than identity labels. Missing security data is unknown,
not a clean security result. Keep thresholds and query logic in Prometheus;
the dashboard presents the resulting signals.

Security inventory metrics use MCP's dedicated metrics port, not a public API.
Read Pod/RBAC snapshots on scrape without retaining another full inventory
cache. Platform Prometheus access to the dedicated port is explicitly scoped
with `mcp.metrics.prometheusNamespace`; leave that setting unset in generic Helm
defaults. Workload namespace labels must survive scraping, while recording
rules retain release identity to prevent cross-release joins.

Store observed security/version/build facts, not effort-hour estimates. Evaluate
effort assumptions at query time so they can be changed retroactively. Prefer
version comparison; only unavailable comparison may fall back to declared image
build age. Missing both remains unknown. Count each workload once using its
highest image effort. Historical chart gaps must remain gaps. Executive Summary
reads Prometheus signals (drift, CVEs, ServiceAccounts, technical debt) and
firing alerts, never the live inventory or a browser risk scoring policy. The
dashboard serves facts to humans; agents act through MCP tools directly.

Tools return complete results without pagination; when a listing grows too
large, return a summary and move detail to a per-item tool and detail page.

## Local desktop dashboard

The local dashboard is the native `desktop` binary, not a
container: it serves on `localhost:17843` (the origin MCP allows) and opens a
Google Chrome application window, falling back to Chromium. Background context
discovery only reads kubelogin's token cache; kubelogin runs only when a person
clicks Sign in. AWS (`aws eks get-token`) and Azure kubelogin in a non-prompting
mode such as `azurecli` are run by discovery itself, which captures their
output and keeps each token until it expires, since they only read the cloud
CLI's session. Sign in runs `az login --tenant … --scope …`, `aws login` or
`aws sso login`, as the plugin and the AWS profile call for. No other credential plugin is ever run.

One Chrome profile may be assigned per kubeconfig user/auth entry in
Settings. Persist its name and directory in the existing kubeconfig auth entry's
`extensions` under `driftmower.codemowers.io/desktop`, with a single `chromeProfile` object. All contexts using the same auth entry share the assignment, including different
API servers. Namespace aliases for that auth entry share it. Preserve unrelated extensions, authentication
fields, current context and the originating files in a merged KUBECONFIG.
Settings always lists every connection. On first Sign in or Connect, prompt for
an existing Chrome profile when several exist, or associate the sole profile
automatically. Provide Clear association so the next attempt chooses again.
Connect reuses the current profile's window; another profile opens a Chrome app
window with its profile identity carried into window-scoped session storage.
Use the person's existing Chrome user-data root, not a separate app profile.
Browser connection selection
is window-scoped; OAuth state and tokens must never cross profile/window state.
Assigned kubelogin flows use a desktop-only cache scoped by connection, Chrome
user-data root and profile, plus a native browser helper. Do not modify kubectl's
exec arguments or cache configuration on disk. Distinguish Azure kubelogin from
int128's plugin using the OIDC issuer/client arguments; never pass OIDC cache or
browser flags to Azure's binary. Cloud CLI sessions remain managed
by their own providers; pass the assigned browser helper where supported.

When an API server answers but has no MCP Service, Settings explains that
Driftmower is not installed, shows a copyable `helm upgrade --install` command
with an explicit `--kube-context`, and notes that organizational policy may
require the cluster's own workflow for new workloads. One-click install is an
explicit, confirmed person action: it runs local `helm` against a temporary
single-context kubeconfig holding the credentials discovery already resolved
(never a credential plugin; SSH jump forwards keep TLS server-name
verification), and deletes it afterwards. One-click install also dry-runs a probe Pod to see whether admission gives
Pods a CA bundle (`SSL_CERT_FILE` or an `/etc/ssl/certs` mount). The images are
`FROM scratch` without CA certificates by design; trust is the cluster's
responsibility (codemowers platform: trust-manager plus `workload-trusted-ca`),
with the chart's optional `trustedCA.configMapName` mounting an admin-provided
bundle elsewhere. When the probe shows no CA bundle, an OIDC install (which would fail every
login) first adds the platform's reusable trust layer under its platform names:
trust-manager and a `trusted-ca-certs` Bundle of public CAs to all namespaces,
then `trustedCA.configMapName=trusted-ca-certs`. Missing cert-manager is
installed only with explicit opt-in. Never add the cluster-wide
`workload-trusted-ca` admission policy from the desktop; that stays a platform
decision. An existing Bundle is never modified. An undeterminable probe only
warns. A full (OIDC) one-click install also adds nodestatd to `kube-system`
when its `codemowers.io` ContainerImage/SourceRepository APIs are missing,
pinning the resolved chart version and using k3s's containerd socket on k3s
and `runtime=crio` when every node runs CRI-O (only with a nodestatd chart that
defines `runtime`; older charts are skipped). One release serves one runtime,
so mixed or other runtimes skip nodestatd with a notice,
before Driftmower so MCP discovers the APIs at start. The anonymous profile
stays MCP-only. MCP's nodestatd notice remains for manual installs. Admission
probes try the release namespace, `default`, then ordinary namespaces, and use
fixed names, because platforms may block `default` and policies may read
`metadata.name`. Clusters with Passmower's OIDCClient
API get chart defaults when a server-side dry run shows admission expanding
the short Ingress host `mcp`; without expansion they get rbac MCP without
Ingresses or hosted UI, reached by port-forward with its canonical OIDC
audience. Discovery ignores single-label Ingress hosts for the same reason.
Clusters confirmed without it get the anonymous
Service-only MCP with `mcp.portForwardOnly`, whose NetworkPolicy leaves
port-forwarding (and so `pods/portforward` RBAC) as the only access path. When
the API cannot be inspected, never guess: offer the command and guide only.
Before changing the cluster, one-click install reads the published chart with
`helm show` and refuses when it does not define every value it would `--set`
(helm silently ignores unknown values), then pins that checked `--version`.
Without a default StorageClass the person chooses one for the operator and
registry scraper claims; never pick one silently. The developer-only
`DRIFTMOWER_INSTALL_CHART` points one-click install at a local chart directory,
checked the same way but unpinned, with the latest published release's
immutable image references.

Desktop Settings groups kubeconfig entries by API server and authentication
identity, retaining namespace aliases within each connection. Never merge
different certificates, tokens or impersonation identities solely because they
reach the same MCP URL. Show certificate authentication in Settings. Render
kubectl commands with an explicit context: prefer a configured alias scoped to
the target namespace within the selected authentication identity; otherwise use
the connection's context plus an explicit namespace. Cluster-scoped resources
need only the context. Without a configured context or local kubeconfig metadata, render a context
placeholder rather than assuming the terminal's current context. Hosted dashboards
may configure `ui.kubeContext` (`KUBECTL_CONTEXT`) as their command context;
Skaffold passes the selected kube context by default. A selected desktop identity
and its namespace aliases always take precedence.

Desktop cluster extensions under `driftmower.codemowers.io/desktop` may specify
`sshJumpHost` (an SSH alias or user@host). Use OpenSSH BatchMode with existing
agent/config/known-host verification, a desktop-owned loopback TCP forward, and
retain the original API URL and TLS certificate verification. Reuse tunnels,
reconnect after exit, and close them on context removal or desktop shutdown.
Reuse a configured SSH master when available, canceling only the desktop-owned
forwarding rule at cleanup; never close a shared master. Without a master, own
a separate SSH connection. Include the jump route in connection identity;
namespace aliases share it.
Never reinterpret a credential plugin as a tunnel or execute arbitrary extension
commands. This extension is desktop-only; kubectl does not establish SSH tunnels.

## Skaffold registry credentials

Skaffold uses `zot-registry-cluster-push-kaniko` in the `driftmower` namespace
on each cluster. It must be an Opaque Secret with Docker auth JSON under
`config.json`; a Docker pull Secret with only `.dockerconfigjson` will not work
for this Skaffold configuration. Verify push authorization against the selected
registry; a successful `GET /v2/` alone does not prove push access.

## SBOM cache persistence

The scanner runs as a single-replica StatefulSet with a retained claim template,
as required by clusters with an `application-workload-storage` admission policy.
It stores regenerable CycloneDX results on a release-owned PVC rather than an
emptyDir. Keep its cache bounded by `operator.sbomCacheMiB`. Where it
exists, Skaffold selects the existing `scratch` TopoLVM class
for an independent claim: it survives Pod deletion but is node-local and is
deleted with the claim. Other clusters must verify that class or override
`operator.sbomStorageClassName`. Do not use a generic ephemeral volume for
these results; Pod replacement must preserve the cache.

Keep vulnerability summaries bounded by retained artifacts and rebuild them
from disk after restart; never retain full SBOMs for metrics. Preserve static
filesystem evidence when Trivy fails. Pending/failed vulnerability status is
unknown coverage, never a completed zero-finding scan. Remove only recognized
legacy analysis sidecars, plain JSON and interrupted writes.

## Image source provenance

Image metadata is not trusted as provenance by itself. Config labels are
inherited through FROM, and layer-appending builders copy the base image's
manifest annotations too. `internal/imagesource` decides whether a
ContainerImage's `status.source`/`status.version` is its own claim. A claim
is discarded as inherited when Docker Official Image annotations appear on a
non-official repository, or when the image extends a known image's layer
chain that carries the same source (and revision). A `status.source`
differing from the image's own metadata is an ImageRepository override and
is kept. The crawler, MCP and UI all apply it: inherited claims are unknown
provenance, never links, versions or changelog matches to the base image's
repository.

## Scan Node selection

The scanner requests `hostUsers: false` and labels scan Pods
`driftmower-scan: driftmower-scan`; platform runtime isolation uses that label
to select a native user namespace rather than Kata. Admission must preserve
that user namespace for Trivy's root identity. New dispatch stops while retained failed
scan Pods reach `operator.trivy.maxFailedPods` (default 20), across all images
and scanner versions. The operator keeps serving artifacts and observing active
attempts. Inspect and fix the failures, then remove reviewed failed Pods to
resume. Restarting the operator does not clear the count.

Java DB is intentionally disabled in the scanner database image. Skip Java
archives when the mounted Java index is absent rather than enabling downloads to repair
Java-image scan failures. OS and other language findings remain supported;
Java archive coverage is excluded and must not be described as a clean scan.

Trivy runs as root of the scan Pod's user namespace with all capabilities
dropped. It skips unreadable files silently, so the scan fails before Trivy
starts if any path is unreadable; the paths become the attempt's reason, which
MCP and the image page show. `operator.trivy.dacReadSearch` adds
CAP_DAC_READ_SEARCH in that namespace where admission policy allows it.

`Node.status.images` is not a complete image inventory: the kubelet reports at
most `nodeStatusMaxImages` images (default 50, the largest ones), so on
a busy cluster every full node lists exactly 50 and smaller images never appear.
Do not require an image to be listed there before scanning it. The scanner
prefers Nodes that report the image, then falls back to the Node names in
`ContainerImage.nodes` (in use before `unused`), trying up to five different
Nodes per artifact. Raising the kubelet limit (`node-status-max-images=-1`)
enlarges every Node object and is not required.

`operator.trivy.strategy` defaults to `operatorNamespace`. The opt-in
`workloadNamespace` strategy selects a running consuming Pod by observed immutable image
identity and Node architecture, run the scan in that namespace on that Node,
and copy its imagePullSecret references. Never copy workload Secret values or
reuse the workload ServiceAccount. Create a dedicated unprivileged scan
ServiceAccount; mirror only release-configured infrastructure pull Secrets for
the scanner and database images. A scan-owned egress policy allows DNS and
uploads to the operator through namespace default-deny rules. Uploads remain audience-bound and validate the
namespace, Pod UID, ContainerImage ownership and persisted attempt. Track,
authenticate and retain scan Pods across namespaces; images without consumers
remain pending. `operator.trivy.cpuRequest` defaults to `100m` per analyzer/Trivy
container, with no CPU limit; configure cluster-specific reservations locally. Superseded
configuration attempts are reset before dispatch so readers do not show old
failures while a new configuration is queued.

## Browser data and caching

Keep crawler state in the crawler; MCP must not retain duplicate source reports.
The dashboard loads workload and Pod inventory in one response per domain, then loads image metadata,
Helm records and SBOMs only for relevant views. No giant snapshot tool is served.
Internal crawler and registry HTTP APIs authenticate projected ServiceAccount
tokens and are not exposed via Ingress. The source crawler additionally serves
its own MCP endpoint: fetched upstream evidence only, without deployed versions
or image/workload associations.
It authenticates audience-bound tokens and requires use on its ClusterMCPServer
(or the existing configured internal caller).
The MCP Service is named `mcp` (the Deployment has the release prefix).

MCP retains RBAC reviews, capability/discovery facts and the reduced workload
graph, but never completed Prometheus responses. Share identical in-flight
requests without Go rate or concurrency limits. Metrics HTTP endpoints under
`/api/observability/` accept GET query parameters and POST JSON on the same path,
using the same authorization and service methods. Successful GETs use private,
Authorization-varying browser caching until the next aligned evaluation window;
POSTs and errors use no-store. MCP `/mcp` protocol requests remain uncached.

## Registry base-image catalog

The registry scraper is an independent single-replica StatefulSet and Service,
running the crawler image as `/driftmower-crawler registry`. Its retained PVC
stores public registry metadata and verified, original `config.json.gz` files;
it never fetches filesystem layer bodies. The mounted ConfigMap supplies the
fully qualified repository list, anchored tag regexes, interval and concurrency,
and reloads without a Pod restart. Storage class remains deployment-specific.

The browser reads this cluster’s registry metadata and hierarchy through the
cluster MCP, which authenticates to the scraper with a projected token for its
audience. There is no catalog section: a container image artifact has a Base
image subpage built from scraper data, and Source Repositories shows the
scraper status beside the crawler's. Dashboard image
metadata includes `platforms` in the scraper's target-image shape. Hierarchy
queries send ordered layer digests and DiffIDs, not synthetic chain hashes.
Match full catalog image chains against every target prefix, retain platform
variants, exact observed tags and historical manifests after tags move, and
show alternatives at the same layer boundary. The empty-filesystem root is
displayed as scratch; layer matches do not prove a unique Dockerfile `FROM`,
and missing intermediate images remain unknown.

Registry rate limiting is host-wide: honor Retry-After and pause sibling
repositories after 429; use a 15-minute backoff if the registry omits the header.
Expose current idle/scraping/throttled status through the catalog response and
Prometheus on the separate 8081 port. Keep metric labels bounded to registries,
states, HTTP codes and scrape results, never tags, digests or error text.
The scraper may mount Docker-auth JSON and the crawler's GitHub token for
GHCR; it has no Kubernetes Secret-read permission. Credentials must only reach
the matching registry's trusted token realm and must never enter catalog data,
logs or metrics. Resolve a GitHub token's owner through /user and reuse only
that small identity result until the token rotates.

## Per-cluster scraping

Crawler and registry scraper run independently in each cluster, with local
state and associations; no shared image/version inventory or cross-cluster
catalog URLs exist. Promotion enables both local components and copies the
source GitHub token as a Secret, never plaintext in Helm values or logs.
Helm capability-gates ClusterMCPServer
registrations for Driftmower and the enabled source crawler. Feeds is owned and
advertised by the agent chart, whose publicMCP.feeds switch controls its public
endpoint. Each Driftmower MCP Ingress is independently toggleable;
crawler Ingress is opt-in and exposes only /mcp, not the internal report API. Driftmower
accepts the stable mcp.<namespace> ServiceAccount audience
as well as its public protected-resource audience; OIDC verification is unchanged.

## UI conventions

Never add sidebar expansion, nested resource entries, subpages or page-section
links. The sidebar contains only fixed section links. Detail pages and all their
descendants appear in breadcrumbs; resource subpage links live only in the
page navbar below the header.

Follow `ui/CONVENTIONS.md` for page anatomy, navigation, cards, tables, states,
charts, findings and the per-view tool-call budget. Change the conventions there
first when a new pattern is needed, then apply it everywhere it fits.

## UI command snippets and charts

User account settings use concise merge patches. Group edits read the live
membership array, filter/remove or deduplicate/add, and merge-patch only those
arrays. Avoid snapshot UID/resourceVersion tests in these copyable snippets;
provider groups still warn that login can restore upstream assignments.
PVC detail exposes +20%, +50%, +100% snippets as fixed absolute storage requests,
so repeating a copied command does not compound growth. Browser volume views
never call expand_volume; that caller-authorized MCP tool remains for agents.

Category series use the shared chart palette. Preserve domain-specific drift
band/tooltip semantics.

## Browser query lifecycle and source repositories

Keep global connection errors, inventory warnings and missing-component notices
in one dismissible yellow overlay fixed to the viewport; they must not move page
content. Keep a refresh control fixed at the top right that reloads the page and
MCP session. Connect preserves a linked page through OIDC sign-in, including its query and
fragment; connections started from Settings or the root default to Executive
Summary. Show a connection spinner on the destination while desktop discovery
retries a port-forward. A confirmed missing
MCP session may trigger one automatic page refresh per endpoint in 30 seconds;
do not replay mutations or create refresh loops.

`useQuery` owns only the mounted component's state; it is not a completed-response
cache. Polls schedule after completion, propagate AbortSignal through HTTP/MCP,
and discard results when the component unmounts or its key changes. Query keys
include cluster identity and resource scope. Registry status polls at 15 seconds;
repository queries at 30 seconds; workload/Pod metrics and PVC detail at 30 seconds.

Private crawler metadata GETs have short freshness windows and strong
representation ETags. Unchanged validation returns 304; errors stay no-store.
Registry observedAt is the catalog update time, not a fresh timestamp per read.
Digest-addressed config downloads remain immutable. Hierarchy MCP POSTs remain
uncached. No extra localStorage or IndexedDB payload cache is maintained.

The global Source Repositories page under Workloads shows
crawler scrape state/timestamps/errors. Workload list/detail pages omit these
source repository panels. Namespace views hide ContainerImage owners and terminal
Succeeded/Failed Pods; keep running crash loops and broken controllers visible.
Resolve one workload with get_workload_sources, or request includeSources on a
get_workloads read. This is optional to avoid listing OCI inventory on every
bootstrap/page. Source linking prefers running immutable digests over mutable tags;
only URLs/names/references are returned, never image layers. Scrape evidence comes
directly from the crawler and remains separate from the workload graph cache.

## Image filesystem and root process observations

Scan Pods inspect the immutable mounted image without executing its binaries.
Enumerate the full filesystem, stream directory entries, and retain only the
1,000 newest regular-file records in a heap. Count MIME types across all
examined files, with unknown/incomplete coverage explicit. Track latest file
modification time separately from config JSON created time. Probe standard
shell paths independently. Persist one gzip CycloneDX artifact with bounded `type: file` components for
newest-file, ELF and shell evidence. All custom properties use the `driftmower:`
prefix; top-level `driftmower:filesystem:latest-modified-at` has no duplicated
path property. Per-file properties carry timestamps and linking details; standard
`mime-type` fields carry valid base MIME types. ContainerImage labels/config
metadata retain their independent lifecycle and are not copied into scan output.
Publish filesystem-only CycloneDX before Trivy, then replace the same artifact
with the merged report. Per-image detail reads include file records; Pod shell
queries request summary evidence only.

Process monitoring is deferred and disabled by default. If explicitly enabled,
node-local root process observations come from nodestatd PodProcess resources,
read on demand with Pod UID and caller Pod/process-resource authorization.
Keep OCI configured process facts separate from live process evidence. Never
interpret Kata guest PIDs as host PIDs. Never retain process environments.
