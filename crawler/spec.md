# Driftmower operator: draft

## Summary

`driftmower-operator` turns the image facts nodestatd records into answers and
fixes. For every source the cluster runs, it reports how far the deployed
versions are behind and which security advisories apply to them; it scans
the content of every image on the node that already holds it; and it
proposes image rewrite rules that hotfix affected workloads through native
Kubernetes admission until the GitOps repository catches up.

It is deterministic. It runs no language model and decides nothing that a
namespace administrator has not activated. Agents consume its reports and
open the permanent fix as a pull request.

Reports are living data and stay in memory: workloads from informers,
releases, advisories and scan findings from the operator's own crawls. They
reach Agents and humans through driftmower-mcp, never through the Kubernetes
API. Only what admission and humans act on is stored as
resources: rewrite rules and upgrade policies, API group
`codemowers.io/v1alpha1`, shared with nodestatd. A restart rebuilds the
model from the API, forges and OSV and rescans images at a bounded rate.

## MCP

driftmower-mcp (`mcp/`) is the one MCP server. It already holds the live
workload inventory, OIDC and ServiceAccount authentication and per-caller
SubjectAccessReview filtering, so the operator's findings are served as its
tools instead of from a second server:

- `get_source_findings`: per source, the deployed versions, how far each is
  behind, applicable advisories and the root workloads running them.
- `get_workload_findings`: the same per root workload the caller may list.

driftmower-mcp reads the crawler's reports over HTTP with a projected
ServiceAccount token for `driftmower-crawler.<namespace>`; the crawler
admits only the ServiceAccounts in its `allowedCallers`. Callers who may list
ContainerImages see every source, others only the versions their visible
workloads run. Scan findings and rewrite rules become further tools the same
way.

## Dashboard and history architecture

All server-side application logic belongs in Go. The dashboard is a static
browser application, served as assets by the Go server, and is an MCP client
alongside agents. Remove the Next.js runtime/BFF, Socket.IO, legacy
`driftmower-be` database and `driftmower-ai` service dependencies. Move any
remaining server-side integrations, including LLM calls and credentials,
into the appropriate Go service; no service credentials enter the browser.

The browser is a public OAuth client using authorization code with PKCE S256,
state and OIDC nonce. It obtains access tokens for the MCP resource URI,
matching the MCP server's protected-resource metadata and audience validation.
ID tokens identify the login, not API authorization. Request only the scopes
needed by enabled capabilities, and enforce permissions and Kubernetes
SubjectAccessReview in Go for both reads and mutations. An MCP token is never
forwarded to a different audience; downstream calls use their own explicitly
authorized identity and audience. Prefer static assets and /mcp on the same
origin; otherwise configure exact allowed origins and required CORS headers.

The existing Go workload inventory is the single implementation of root owner
resolution. Extend it through API discovery for custom owners, preserving UID
checks, cycle/depth bounds and explicit unresolved ancestry. MCP tools,
dashboard resources, findings and metric generation reuse this model; the
browser does not reconstruct ownership independently.

Use MCP Streamable HTTP with its negotiated protocol's subscription and SSE
mechanism, not a second Socket.IO protocol or a legacy standalone SSE
transport. Publish scoped resource-change notifications; clients reread the
corresponding authorized snapshot. Coalesce updates, bound queues, and resync
after reconnect instead of assuming notification delivery is durable.
Subscriptions must not disclose out-of-scope names or data, and must stop on
expired authorization and be reauthorized when permissions change. The browser
uses an MCP transport capable of bearer-authenticated fetch streams, rather
than placing access tokens in EventSource URLs. No explicit refresh button:
changes refresh live views automatically, with polling only as a fallback.

Current state comes from Kubernetes CRDs, live workload inventory and crawler
findings. History comes from a dedicated Prometheus instance in the driftmower
namespace, provisioned with the installed Prometheus Operator. Scrape every
five minutes. Keep its endpoint independently configurable from the general
cluster monitoring endpoint. Go exposes scoped historical queries through MCP;
the browser never directly accesses cluster-wide Prometheus. Export raw drift,
version and coverage measurements, not estimated hours or dollars. Compute
debt estimates from history and configurable assumptions in application code.
Missing samples and incomplete scans are unknown, not zero drift or no CVEs.

The scan dispatcher watches ContainerImages and reconciles existing resources
at startup. New platform digests enter a deduplicated bounded Trivy queue;
missing artifacts and changed extraction configuration requeue work. This
requires no image admission webhook.

## Inputs

| Source | Provides |
| --- | --- |
| nodestatd `ContainerImage` | Digest, platform manifests, nodes holding it, references, `status.version`, `status.source`, revision and base labels |
| nodestatd `ImageRepository`, `SourceRepository` | Repositories in use and their sources, owned by ContainerImages |
| Pods and their controlling owners | Which workloads run which references, for impact and rollout |
| Forge APIs | Releases and repository security advisories per SourceRepository |
| OSV.dev | Advisories by package and version, by Git commit, and for OS and language packages found by scans |
| Registries | Tag to digest resolution and platforms of rewrite targets |

### Workloads

Impact, rollout and retirement are judged per root workload, not per Pod. The
operator follows each Pod's controlling owner reference up to an object
without one, mapping owner kinds to resources through API discovery so custom
roots such as a CloudNativePG Cluster resolve too, with cycle detection and a
depth limit; an ownerless Pod is its own root. A root can run several image
sets at once during a rollout or a partitioned StatefulSet update, and each
is reported. The mapping lives in memory from Pod and owner informers; no
per-workload resource is stored. Pull Secret names a workload references are
recorded, never their contents, for scanning private images.

### Mirrors

Pods often pull through mirrors, such as `zot.example.com/quay.io/jetstack/…`
or `mirror.gcr.io/grafana/grafana`. The operator maps a mirror repository to
its upstream for release, advisory and registry lookups: path-embedded
upstreams by convention, others through a configured prefix map. Rules match
and rewrite within the repository the Pod uses, so a mirrored workload stays
on its mirror.

Forge and OSV requests go through a client that reaches only public
addresses and identifies as `driftmower-operator (+<repository URL>)`. An
optional token raises GitHub's limit of 60 unauthenticated requests per hour;
without one the operator spreads requests over its poll interval.

## Scan Job lifecycle

The operator creates eligible Jobs without waiting for scans to finish. A
PriorityClass-scoped ResourceQuota admits at most `parallelism` non-terminal scan
Pods in the namespace. Other Driftmower components are outside that quota.
The scan class defaults to priority 100000 with preemption disabled, above
end-user priority 0 and below the cluster's infrastructure classes (1000000+).
Jobs watch their owning ContainerImage, and Job/Pod events trigger reconciliation.
The 15-minute execution deadline belongs to each Pod, so waiting for quota does
not expire a Job. There is no separate operator global or per-node admission cap;
an architecture node selector and required hostname affinity constrain scans to
known cached-image hosts. Each Job lists at most three eligible hosts, selected
pseudorandomly by a stable hash of Job name and hostname to spread images across
the cluster without reshuffling on reconciliation. The scheduler chooses among that subset
according to resource availability. Target image volumes retain pullPolicy Never.

The operator uses a stable Job name per ContainerImage/platform. The SBOM cache
key separately includes the scanner and database versions. Unchanged Pod specs
use native Job retries (backoff limit 6); an exhausted Job stays failed. A changed
desired Pod spec replaces the Job under the same name, so that replacement also
removes the previous Job record.

Finished successful Jobs and their Pods are eligible for cleanup after two
minutes; failed Jobs after 48 hours. Jobs start with the failure TTL and the
operator shortens it on successful completion, including after operator restarts.
Pending image-volume cache misses do not trigger native Job backoff. The operator
ends those attempts and can replace them when it selects a different node or
immutable image reference. Successful Jobs can disappear between five-minute
Prometheus scrapes; Job state metrics are not durable success counters.

## Drift and advisories

For each SourceRepository the operator keeps a report in memory:

- **Releases**: the bounded list of recent releases (tag, parsed version,
  prerelease, published time, link) and conditional request validators.
- **Advisories**: repository security advisories and OSV entries for the
  source, each with severity, affected ranges and patched versions as
  published, and a link.
- **Deployed**: every distinct `status.version` of in-use ContainerImages of
  the source, with the image repositories it was seen in.
- **Findings**: per deployed version, how many releases and which minor and
  major versions it is behind, the newest patch release on its own minor, and
  the advisories whose ranges contain it with the lowest patched version
  above it.

Version handling is tolerant and explicit about doubt:

- Versions parse as semver after dropping a leading `v`; suffixes such as
  `-alpine` are kept for display but ignored for ordering. A version that
  does not parse is reported as unknown, never as drift. So is a version
  with no known stable release on its own tag prefix, as before a source's
  first successful crawl: no releases is not the same as current.
- Advisory ranges come from GitHub's reviewed global advisory database when
  it has the advisory: one range per release branch, constraints joined by
  commas and ANDed, with a first patched version. Otherwise from OSV's
  structured ranges. Repository advisories are maintainer free text, such as
  explicit version lists or one bound per branch (`<v1.12.14,<v1.15.4,<v1.16.2`);
  they are parsed tolerantly, and a range that admits more than one reading
  makes the advisory "possibly applicable", shown separately.
- When an image carries `org.opencontainers.image.revision`, OSV is also
  queried by commit, which needs no version parsing at all.
- Monorepos whose tags carry a component prefix (`loki-3.1.0`) match only
  tags with the prefix of the deployed version's tag.
- Gitea and Forgejo have no repository advisories; their sources get
  releases from `releases.rss` and advisories only from OSV and GitHub's
  database by package.

Reports refresh on a jittered interval (default 6h) and immediately when a new
version of a source appears on nodes.

## Image scanning

The operator watches ContainerImages and dispatches Trivy scan Jobs itself;
Trivy Operator is not used. Work is deduplicated by platform manifest digest,
so a multi-platform image is scanned once per platform actually present on
nodes, not once per Pod or node. Extraction is repeated when the scanner
version or extraction configuration changes. CVE evaluation is refreshed
when the vulnerability database changes, even when the image does not.

Each Job mounts the target as a read-only Kubernetes OCI image volume at
`/target`, using a digest reference recorded as present on a candidate node
and `pullPolicy: Never`. The dispatcher selects a node whose ContainerImage
inventory holds that platform manifest and sets `nodeSelector` to its actual
`kubernetes.io/hostname` label value (do not assume it equals the Node name).
Verify that the label uniquely selects that node; otherwise leave the scan
pending with an explicit reason. This retains scheduler resource, taint and cordon checks;
do not bypass the scheduler with `nodeName`. ImageLocality scoring alone is
not a placement guarantee. If no eligible node holds the image, leave the
scan pending with an explicit reason. If image garbage collection races the
scan, refresh inventory and retry with bounded backoff; do not silently pull
the target from a registry. Verify runtime image-volume support and digest
reference resolution on the deployed Kubernetes/runtime versions.

Run a pinned Trivy image with `trivy rootfs` against `/target` to extract a
CycloneDX SBOM and evaluate OS and language-package vulnerabilities. Enable
vulnerability scanning explicitly when producing CycloneDX; it is not implied
by that output format. Nothing from the target image executes. Record the
platform digest, scanner version, extraction configuration, database version,
scan time and completeness alongside results. A failed or unsupported scan is
unknown coverage, never a clean result.

Dispatch limits are configurable: `scan.maxConcurrentJobs` bounds all active
scan Jobs, and `scan.maxConcurrentJobsPerNode` bounds load on each node.
Count pending Jobs against the global limit and reserve a node slot before
dispatch; constrain that Job to its selected eligible node. Reconstruct active
work from owned Jobs after restart and use leader election so replicas do not
multiply the limits. Jobs have resource requests/limits, deadlines, bounded
retries and cleanup after results are collected.

Trivy requires vulnerability databases and, for some analyzers, supplementary
data. Package the vulnerability DB and Java index in a versioned OCI filesystem
image and mount it as a second read-only image volume in each scan Job. The
scanner container runs the Trivy image with DB updates and online resolution
disabled; there is no Trivy server. A short Go upload container runs after the
scan to collect its SBOM. Include the database-image digest in the scan cache
key so replacing the DB image reevaluates unchanged target images. Refresh
the DB image centrally; do not download databases independently for every scan. Network-isolated workers
must have their required data staged before scanning. Keep the target mount
read-only, disable ServiceAccount token mounting, drop capabilities and use
writable scratch space only for Trivy cache/output. Validate filesystem
permissions and analyzer coverage before enforcing a non-root scanner UID.

Keep current scan summaries and artifact references in operator-owned CRDs,
linked to the ContainerImage; do not place unbounded SBOMs in object status or
Pod logs. Full SBOM/result artifact storage and bounded authenticated result
collection still need an implementation decision. Expose current findings
through MCP/UI, and export bounded numeric vulnerability/coverage metrics for
Prometheus history. Do not use Prometheus as SBOM storage.

Rewrite-target verification is a distinct operation: it may deliberately pull
a new target on the required architecture before scanning. Ordinary scans of
existing ContainerImages remain cache-only.

Validate private-image credential enforcement and admission policies on the
actual cluster. A cached image is not a guarantee that a different Pod may
mount it without credentials; report an explicit unavailable scan rather than
copying workload secrets into the operator namespace.

## Hotfix image rewrite rules

A rewrite rule replaces exact image references with a fixed digest-pinned
reference of the same repository when Pods are created. Rules are parameter
objects of two static MutatingAdmissionPolicies
([examples/image-rewrite-policy.yaml](examples/image-rewrite-policy.yaml)),
so applying them needs no webhook and survives the operator being down:

- `ImageRewriteRule` is namespaced and applies to Pods of its namespace.
- `ClusterImageRewriteRule` applies everywhere and is reserved for cluster
  administrators.

[examples/imagerewriterule.yaml](examples/imagerewriterule.yaml) shows a rule
as proposed for a real finding.

Rule contract:

- `spec.repository` names one image repository. Every `match.references`
  entry and `rewrite.reference` must belong to it, and `rewrite.reference`
  must be pinned by digest; CRD validation enforces both, so a rule cannot
  swap in another image.
- `match.references` are the exact strings Pod specs carry, mirror forms
  included, so admission needs only string equality.
- The rewrite sets `imagePullPolicy: IfNotPresent` and annotates the Pod with
  the rule name, so running state that differs from the GitOps declaration is
  visible on every affected Pod.
- Only Pods controlled by ReplicaSets, StatefulSets, DaemonSets and Jobs are
  rewritten. Operators such as CloudNativePG compare Pod images with their
  own specs and would fight a rewrite; their findings are reported only.

Lifecycle, recorded in `spec.state` and status conditions:

1. **Proposed**: the operator creates a rule when an advisory applies to a
   deployed version and a patched release exists on the same minor. It
   resolves the target digest, checks that it covers every node architecture
   that runs the image and scans it (`TargetVerified`).
2. **Active**: a namespace administrator sets `state: Active`. A
   ValidatingAdmissionPolicy rejects activation by the operator's own
   ServiceAccount unless the rule came from an upgrade policy, so the
   operator proposes and humans decide or pre-approve.
3. **Rolling out**: the operator evicts the Pods running a matched reference
   through the Eviction API, honoring PodDisruptionBudgets, one Pod per
   workload at a time and waiting for readiness. Jobs are not evicted; their
   next Pods are rewritten. Workload specs are never patched, so GitOps
   reconcilers see no drift to revert.
4. **Retired**: once no controlling workload template declares a matched
   reference, because the GitOps change landed, the operator marks the rule
   Retired, which the policies ignore, and deletes it after a grace period.

Setting a rule back to `Proposed` and evicting again rolls back.

## Upgrade policies

Hotfixes react to advisories; upgrade policies keep chosen images current. An
`ImageUpgradePolicy` (namespaced) or `ClusterImageUpgradePolicy` is a human
pre-approval: it selects workloads by namespace and labels and images by
repository prefix, and states what the operator may do on its own:

- `scope`: `patch` or `minor` bumps within the deployed version's line.
- `window`: a cron expression for when activation and eviction may happen,
  such as Thursdays 18:00; there are no CronJobs.
- `defer`: how long a release must have been out before it is used, so
  broken releases are usually yanked first.
- `repull`: for floating tags such as `:1.2` or `:latest` with
  `imagePullPolicy: Always`, evict Pods whose running digest differs from the
  registry's current one instead of writing a rule; the manifest author chose
  that boundary.
- Exclusions for workloads with PersistentVolumeClaims or operator-controlled
  Pods.

Rules created from a policy carry `spec.policyRef`, and the activation guard
lets the operator activate only those, inside the window. Policies hold no
schedule state; the operator recomputes what is due from releases, rules and
the clock.

`driftmower-operator plan` runs the same evaluation against the current
kubeconfig context and prints the rules and evictions it would create,
without writing anything.

## Hand-off to Agents

Rewrites are hotfixes; the GitOps repository stays the source of truth. When
a rule becomes Active, the operator wakes a configured harness Task through
the operator wake endpoint with the source, versions, advisories and rule.
The Agent locates where the GitOps repository sets the version, opens the
bump pull request and records it in `spec.followUp`. Drift without advisories
goes the same way on the Agent's own schedule, through the MCP tools.

## Later

- Signature and provenance verification of rewrite targets.
- Pre-warming targets on all nodes before activation through nodestatd
  `spec.pin.warm` once nodestatd acts on it; until then target scans pre-pull.
- Base image tracking from `org.opencontainers.image.base.name`, so an
  outdated base shows even when the application is current.

## Acceptance criteria

- For every SourceRepository with releases, MCP lists deployed versions with
  their root workloads, how far each is behind and applicable advisories;
  cert-manager v1.20.0 shows GHSA-8rvj-mm4h-c258 fixed in 1.20.3.
- An unparsable version or range is shown as unknown or possibly applicable,
  never as drift or as an applicable advisory.
- Until a source is crawled without errors, as after a crawler restart, its
  versions show as unknown and every finding about them names the gap; none
  is reported as current and clean.
- Every in-use platform manifest is scanned once by a Pod on a node already
  holding it, without a registry pull, and its findings are served over MCP.
- A proposed rule changes no Pod. An activated rule rewrites new Pods of the
  allowed controllers only, annotates them and is rolled out by eviction
  within PodDisruptionBudgets; operator-controlled Pods are untouched.
- A rule cannot be activated by the operator unless an upgrade policy created
  it and its window is open, cannot target another repository and cannot use
  an unpinned reference.
- Findings name root workloads, including custom roots, and mirrored images
  resolve to their upstream releases and advisories while staying on their
  mirror when rewritten.
- `driftmower-operator plan` shows the same rules and evictions the operator
  would create, without writing.
- With the operator stopped, active rules keep applying and nothing else
  changes.
- Rules retire on their own once the declared workload versions are fixed.
