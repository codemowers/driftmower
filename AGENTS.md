# Repository guidance

Driftmower is cluster infrastructure with one installation per cluster.

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
cache. Keep scanner vulnerability summaries bounded by the retained artifact
cache and rebuild them from disk after restart; never retain full SBOMs for
metrics. Platform Prometheus access to the dedicated port is explicitly scoped
with `mcp.metrics.prometheusNamespace`; leave that setting unset in generic Helm
defaults. Workload namespace labels must survive scraping, while recording
rules retain release identity to prevent cross-release joins.

Store observed security/version/build facts, not effort-hour estimates. Evaluate
effort assumptions at query time so they can be changed retroactively. Prefer
version comparison; only unavailable comparison may fall back to declared image
build age. Missing both remains unknown. Count each workload once using its
highest image effort. Historical chart gaps must remain gaps. Executive Summary
actions come from firing alerts, not a separate browser risk scoring policy.

Follow the engineering guidance published by codemowers-mcp at
https://mcp.codemowers.io. Read its advisory index and the sections relevant to
the task before making development, build, or deployment decisions. Use the
connected codemowers MCP tools when available.

For cluster-specific decisions, discover the target cluster's capabilities and
policies rather than assuming that another cluster has the same configuration.

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

## Scan Node selection

Java DB is intentionally disabled in the scanner database image. Skip Java
archives when the mounted Java index is absent rather than enabling downloads to repair
Java-image scan failures. OS and other language findings remain supported;
Java archive coverage is excluded and must not be described as a clean scan.

`Node.status.images` is not a complete image inventory: the kubelet reports at
most `nodeStatusMaxImages` images (default 50, the largest ones), so on
a busy cluster every full node lists exactly 50 and smaller images never appear.
Do not require an image to be listed there before scanning it. The scanner
prefers Nodes that report the image, then falls back to the Node names in
`ContainerImage.nodes` (in use before `unused`), trying up to five different
Nodes per artifact. Raising the kubelet limit (`node-status-max-images=-1`)
enlarges every Node object and is not required.

## Browser data and caching

Keep crawler state in the crawler; MCP must not retain duplicate source reports.
The dashboard loads workload and Pod inventory in one response per domain, then loads image metadata,
Helm records and SBOMs only for relevant views. No giant snapshot tool is served.
Crawler and registry scraper run independently in each cluster. Their internal
HTTP APIs authenticate projected ServiceAccount tokens and are not exposed via
Ingress. Browsers and agents query only the selected cluster's MCP; no cross-cluster
catalog URLs, public catalog MCP servers, or shared image/version inventory exist.
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
audience. Catalog pages use only scraper data. Dashboard image
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

Every cluster owns its crawler and registry scraper state. Promotion enables
both local components and copies the source GitHub token as a Secret, never
plaintext in Helm values or logs. No crawler/registry Ingress routes or
ClusterMCPServer registrations are installed. Cluster associations remain local.

## UI command snippets and charts

User account settings use concise merge patches. Group edits read the live
membership array, filter/remove or deduplicate/add, and merge-patch only those
arrays. Avoid snapshot UID/resourceVersion tests in these copyable snippets;
provider groups still warn that login can restore upstream assignments.
PVC detail exposes +20%, +50%, +100% snippets as fixed absolute storage requests,
so repeating a copied command does not compound growth. Browser volume views
never call expand_volume; that caller-authorized MCP tool remains for agents.

Use MetricBar for capacity/comparison bars and TimeSeriesChart for area/sparkline
history. Capacity thresholds come from usageBarColor; category series use the
shared chart palette. Preserve domain-specific drift band/tooltip semantics.

## Browser query lifecycle and source repositories

Keep global connection errors, inventory warnings and missing-component notices
in one dismissible yellow overlay fixed to the viewport; they must not move page
content. Keep a refresh control fixed at the top right that reloads the page and
MCP session. Connect immediately navigates to Executive Summary with a spinner,
including while desktop discovery retries a port-forward. A confirmed missing
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
uncached. Prometheus keeps its existing private, aligned HTTP caching. No extra
localStorage or IndexedDB payload cache is maintained.

The global Source Repositories page under Workloads, below Base Images, shows
crawler scrape state/timestamps/errors. Workload list/detail pages omit these
source repository panels. Namespace views hide ContainerImage owners and terminal
Succeeded/Failed Pods; keep running crash loops and broken controllers visible.
Resolve one workload with get_workload_sources, or request includeSources on a
get_workloads read. This is optional to avoid listing OCI inventory on every
bootstrap/page. Source linking prefers running immutable digests over mutable tags;
only URLs/names/references are returned, never image layers. Scrape evidence comes
directly from the crawler and remains separate from the workload graph cache.
