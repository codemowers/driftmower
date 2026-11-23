# Metrics, alerts and scan semantics

[Driftmower](../README.md)

The Cluster view shows network receive/transmit and disk read/write throughput
per node and across the cluster, averaged over five minutes. Rates and node
aggregation run in PromQL. Whole-disk selectors exclude partitions and
device-mapper layers; network selectors exclude common virtual interfaces.
Each card links to its Prometheus graph. Missing series remain unavailable.

MCP keeps expensive RBAC and cluster-capability caches, but retains no completed
Prometheus responses or crawler reports. The browser reads crawler summaries
and source details through the selected cluster’s MCP, which queries its private
crawler API and applies the caller’s access policy. Source notes and changelogs are fetched only for detail views.

Metrics endpoints share GET and POST paths under `/api/observability/`:
`cluster-health`, `alerts`, `namespace-resources`, `workload-resources`, and
`log-rate`. GET uses query parameters; POST uses a JSON object with the same
arguments (`namespace`, `uid`, `pod`, as applicable). Successful GET responses
use `Cache-Control: private, max-age=…, must-revalidate` and
`Vary: Authorization, Origin`, expiring at the next aligned evaluation boundary
and no later than token expiry. POSTs and errors use `no-store`. Configure the
interval with `OBSERVABILITY_ALIGNMENT_MS` (15 seconds by default).

Log rates use Loki's built-in LogQL `sum(rate(selector[5m]))`, returning one
aggregate of stored entries per second for the requested namespace or Pods.
They require `LOKI_URL`, list Pods, and permission to read logs in the selected
scope. No custom Alloy counter or `LOG_RATE_*` configuration is used. Missing
samples remain unavailable rather than being reported as measured zero.

All rules consuming Driftmower component metrics ship in this chart's
`templates/prometheus-rules.yaml`. Security rules use `driftmower.security.*`
groups. Generic platform rules remain in the platform monitoring chart. Rule
annotations distinguish evidence, impact, next checks and known limitations
so both people and agents can interpret them.

The scanner exports per-image/platform availability, artifact acceptance time,
retry-budget exhaustion and vulnerability counts by severity and explicit fix
availability. Counts deduplicate vulnerability ID/component pairs and exclude
explicit resolved, false-positive or not-affected analysis states. They contain
no CVE IDs, package names or descriptions in metric labels. Bounded summaries
are parsed once per artifact, rebuilt from the retained cache after restart,
and removed on eviction. Acceptance time is not vulnerability database age.

MCP's `/security-metrics` endpoint on its dedicated metrics port exports
running-container image digests, unresolved digest counts and active Pod counts
per ServiceAccount RBAC risk/scope. It reads Pods, Roles, ClusterRoles and their
bindings on each five-minute scrape without retaining another inventory cache.
Incomplete reads fail the scrape rather than publish empty success. Both direct
subjects and standard ServiceAccount group bindings are evaluated; RoleBindings
remain namespace-scoped even when referring to cluster-admin-equivalent rules.
Named-object reads do not establish unrestricted Secret access. These signals
do not prove a mounted token, exploitation, external cloud permissions or cover
every combination of permissions that could enable privilege escalation.

Recording rules deduplicate platform findings across image aliases and join
them to observed running digests in Prometheus. Alerts cover critical findings,
fixable high findings, missing/old/exhausted scans, cluster-admin-equivalent and
other broad ServiceAccount grants, and unavailable security metrics. The first
thresholds are 15 minutes for critical/fixable-high findings and cluster-admin
use, 30 minutes for missing coverage and broad grants, and seven days plus one
hour for old artifacts. Registry throttling/failure and advisory collection
coverage alerts ship alongside their components. Crawler metrics expose only
aggregate pending/scraping/failed/ready counts and inventory readiness.

The security PodMonitor retains workload namespace labels and is selected
by release-owned history monitoring. To let platform monitoring read the
dedicated port, set `mcp.metrics.prometheusNamespace`; Skaffold explicitly uses
`PROMETHEUS_NAMESPACE` or `monitoring`. The selected Prometheus still needs to
select these monitors/rules and configure Alertmanager delivery. The history
Prometheus does not configure Alertmanager delivery by default.

Run `scripts/test-security-rules.sh` with Helm, promtool and Python/PyYAML to
validate expressions and exercise alias deduplication, cross-namespace image
joins, missing scans and RBAC scope. Go tests cover producer correctness,
restart recovery, eviction and failed inventory reads.

Finished scan metrics retain the actual `trivy_version` and vulnerability DB
build timestamp (`db_version`), also on availability, acceptance-time and finding
metrics. These describe the DB used for that scan. When the Java index is absent,
JAR/WAR/EAR/PAR files are skipped. Images containing those archives report
`state="partial"`, `coverage="partial"` and `reason="java_db_unavailable"`;
OS and other language findings remain usable. Coverage and DB version persist in
CycloneDX properties. Legacy artifacts have `coverage="unknown"`.

The Container Images list reads Trivy lifecycle status through Prometheus.
`driftmower_image_scan_state{digest,state,trivy_version,db_version,coverage,reason}` exports one state per immutable
platform digest; Pod/workload counts never multiply scan observations. Repeated
image aliases are deduplicated. Image/index-to-platform relationships use the
separate `driftmower_image_manifest_info` metric and recording rule. An index
badge aggregates only its observed platform manifests; a repository badge
summarizes its distinct running digests.

Pending includes queued or retryable attempts, Scanning means an active scan,
Failed means the current scan retry budget is exhausted, and Done requires a
usable artifact for the current scanner/database identity. Partial platforms
remain visible. Missing, stale or conflicting metrics show Unavailable, never
Pending or Done. Status is delayed by scraping/rule evaluation. Failure text and
full SBOMs stay outside metric labels. `get_image_scan_statuses` and GET/POST
`/api/observability/image-scan-statuses` accept up to 100 digests per request,
require list ContainerImages, and query Prometheus without downloading SBOMs.
The browser polls only filtered list entries every 30 seconds and uses the
existing private HTTP caching policy. `SCANNER_INSTANCE` and `POD_NAMESPACE`
scope status reads to the chart's scanner release.

Executive Summary action items read firing alerts from Alertmanager through
MCP's namespace authorization, group signals for the same affected resource,
and show five items ordered critical, warning, info, then other. Silenced and
inhibited alerts are excluded. This replaces the summary's browser-derived
upgrade/AI scoring; workload-specific action tools remain available.

CVE and ServiceAccount history charts query retained raw facts in the global
Prometheus by default. `history.enabled=true` provisions an optional dedicated
history Prometheus again; disabling it retains its PVCs but does not migrate old
history into the global service. Available history follows the selected
Prometheus's retention. The CVE chart is disabled with `operator.enabled=false`;
the ServiceAccount chart is disabled with `mcp.userAccess.enabled=false`, and
disabled charts make no history requests. CVE figures count vulnerability/component findings per
running digest, not globally unique CVE IDs. ServiceAccount figures count
distinct identities, not Pods or bindings; cluster-admin identities are excluded
from the other-broad-permissions series. Coverage gaps remain unknown.

Technical debt remains an explicit heuristic evaluated by PromQL at query time:
an outdated comparable image contributes one upgrade unit. When comparison is
unavailable, declared OCI image build age contributes age divided by the assumed
days per upgrade (initially 365). Each workload contributes its highest image
estimate, multiplied by assumed hours per upgrade (initially 1). Known version
comparison always takes priority over age. Missing both comparison and build
timestamp is counted as an incomplete estimate, not zero work. Both assumptions
are configured on MCP with `TECHNICAL_DEBT_HOURS_PER_UPGRADE` (default `1`)
and `TECHNICAL_DEBT_BUILD_AGE_DAYS_PER_UPGRADE` (default `365`), exposed by Helm
as `mcp.technicalDebt.hoursPerUpgrade` and
`mcp.technicalDebt.buildAgeDaysPerUpgrade`. Changes recalculate the selected
window; estimated
hours are never stored in Prometheus. Version/build facts must have been scraped
at the historical point: no chart invents observations before collection began.

`query_signal_history` exposes these bounded calculations to agents. Browser
reads use GET/POST `/api/observability/signal-history`, with private aligned GET
caching and no retained MCP response cache. Cluster scope requires cluster-wide
list Pods; explicit namespace scopes require authorization for each namespace.
The window accepts `hours` (1–2160) or `days` (1–90), bounded to 90 days,
and results to eight aggregate series. Executive Summary has one Time window
dropdown for all history charts: 3 months (90 days), month (30 days), 2 weeks,
week (default), 3 days, 48h, 24h and 1h. Short windows use finer query steps.
Current container counts use `current=true` for an independent instant query;
current counts, top-five workloads and firing alerts remain current regardless
of the history selection. The instant request bypasses the browser history queue. Browser
history tools and charts share a three-request queue; MCP has no per-caller
observability concurrency limit. `go test ./mcp/internal/observability -run TestSignalHistoryPromQL`
also runs synthetic query tests when `promtool` is installed.

## SBOM size limits

The operator serves scan metrics at `/metrics`. `driftmower_sbom_size_bytes`
is a histogram of reported SBOM sizes, including oversized artifacts. Its last
finite bucket is the 32 MiB acceptance limit; observations above it appear only
in the cumulative `+Inf` bucket. The `+Inf` bucket itself includes every result,
so it is not a failure count. Upload retries may repeat observations. Legacy
uploaders that send an oversized body instead of a size report contribute a
lower bound of 32 MiB plus one byte, rather than the full file size.

`driftmower_sbom_size_limit_exceeded_bytes{image,digest}` records the last rejected
size, identifying the ContainerImage resource and its platform manifest digest.
A successful upload clears that image's warning; operator restart resets these
process-local metrics. Oversized uploaders send only a small authenticated size
report, so rejected artifacts are measured without sending their contents.
When the corresponding Prometheus Operator APIs are available, the chart creates
an operator PodMonitor and a `DriftmowerSBOMTooLarge` warning PrometheusRule,
selected by the configured Prometheus. Platform Prometheus instances
must select their labels to scrape/evaluate them; notification delivery requires
that Prometheus to have an Alertmanager configured.


## Compressed SBOM artifacts

Each scan Pod annotates and gzip-compresses its CycloneDX result before upload.
The operator accepts gzip artifacts only and retains `<artifact-key>.json.gz`
on its PVC. There is no plain-JSON cache fallback or migration. Replace the
old SBOM cache when switching from an older operator. Deploy the updated
operator before the MCP/browser changes so artifact reads use the new gzip
contract.

The 32 MiB result limit and size histogram refer to decompressed content.
Validation checks the gzip checksum and rejects truncated, invalid and oversized
results. Cache eviction counts compressed file bytes. Prometheus summaries are
rebuilt from compressed artifacts after restart without retaining full SBOMs.

The scanner derives each artifact's vulnerability findings (CVE, severity,
score, package, installed and fixed version, a short description) once and
stores them beside the artifact, inside the same cache budget; a replaced or
evicted artifact never answers from stale findings. `get_image_scans` with
`includeFindings` returns them for every requested digest through one scanner
request, so a view costs one tool call. Full SBOMs are fetched only for the
SBOM page and the download button, through the authenticated
`/api/image-scans/sbom` endpoint: MCP rechecks ContainerImage list permission
and artifact association, then streams the operator's gzip bytes without
recompression.

## Agent registration and MCP exposure

When the ClusterMCPServer API is available, the chart advertises `driftmower`
when `mcp.enabled` and either ServiceAccount authentication or anonymous access
are enabled, and `driftmower-crawler` when `crawler.enabled` and
`crawler.mcp.enabled` are enabled. Registration URLs use internal Services.
The source crawler offers compact scrape summaries and, by repository URL,
fetched releases, licenses and advisories. It never returns deployed image or
workload associations. Its caller needs an audience-bound Kubernetes token and
`use` on the `driftmower-crawler` ClusterMCPServer. Existing configured internal
callers retain access.

`mcp.ingress.enabled` (default true) and `crawler.ingress.enabled` (default false)
independently expose the main MCP and source crawler. Their `ingress.host` values
configure the host; the crawler publishes only `/mcp`. Turning off Ingress leaves
internal Service access and registrations available. The main registration uses
the stable `mcp.<namespace>` token audience; its public resource audience remains
accepted too. `mcp.publicUrl`, when set with Ingress enabled, also supplies the
registration's public URL and client configuration annotations.

Feeds remains owned by the agent chart in `../agent-refuckto`. Its `feeds.enabled`
setting deploys and registers it, and `publicMCP.feeds` exposes the authenticated
`/mcp/feeds` endpoint through that chart's existing dashboard Ingress. Driftmower
has no Feeds namespace setting or duplicate registration.

Pod configuration issues are evaluated once on inventory updates. Missing CPU
and memory requests/limits join security issues in the same issue list; positive
Pod-level budgets satisfy the corresponding setting. Ephemeral debug containers
cannot declare resource budgets and are excluded from those checks. Completed,
failed and terminating Pods contribute no issues unless their direct controller
is a Job, including Jobs grouped under a CronJob. Namespace indicators combine
the already evaluated Pod issues, independently of Prometheus.

## Image scan coverage history

Executive Summary counts distinct running image digests, deduplicated across
namespaces and container replicas. A digest belongs to exactly one category:
Trivy + files, files only, legacy Trivy only, or no retained scan evidence.
Image/index aliases require evidence for every known platform before claiming
that stage. Trivy availability includes partial results and does not imply Java
archive coverage or zero vulnerabilities.

`driftmower_image_filesystem_available{image,digest}` reports retained CycloneDX
filesystem evidence independently of pending, failed or completed Trivy status.
It uses the scanner's bounded artifact summaries, rebuilt from disk on restart;
evicted files cease to count. The release-scoped recording rule ships beside
its producer. `query_signal_history` accepts `signal=scan_coverage` for current
or historical aggregates, using the same namespace authorization and window.
Before this filesystem metric exists, or while scanner inventory is unavailable,
the chart leaves gaps instead of claiming every image lacks a scan.

Scan-coverage alias joins run once per minute in the release-owned
`driftmower.security.scan_coverage` recording group. It records one observed
stage per image, then associates that stage with running namespace/image pairs.
Browser history counts distinct digests from
`driftmower:running_image_scan_stage:info`, without repeating platform joins
for every time step. Both recordings retain release identity, and the query
scopes it to the configured scanner release. Earlier unrecorded periods remain
gaps. The Cluster node table reuses the same memory-used/capacity breakdown
as cluster totals; it performs no extra per-node requests.
