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
  does not parse is reported as unknown, never as drift.
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

The operator scans each platform manifest of every in-use ContainerImage
once, since a digest's content never changes; matching the resulting package
inventory against advisories is repeated centrally whenever advisories change.

A scan is a Pod pinned with `nodeName` to a node whose ContainerImage entry
holds that manifest. It mounts the image as an OCI image volume by digest with
`pullPolicy: IfNotPresent`, so the node needs no pull and no registry
credentials, and the platform is the node's own. The scanner container is the
operator's own image; nothing from the scanned image executes.

The scanner reads, read-only:

- OS package databases: dpkg status, apk installed, RPM database.
- Go binaries' embedded build information (main module, version, dependencies).
- Language manifests: `package.json` under `node_modules`, Python
  `*.dist-info/METADATA`, JAR manifests and `pom.properties`.
- `/etc/os-release` for the distribution and release.

It prints a bounded JSON inventory and exits; the operator reads it from the
Pod log and deletes the Pod. Scan Pods run in the operator namespace with no
ServiceAccount token, a deny-all NetworkPolicy, a read-only root filesystem,
`hostUsers: false`, low priority, small resource limits and a timeout. A
parser bug therefore exposes nothing but the image the Pod already sees.

Per platform manifest the operator keeps in memory the distribution, the
package inventory and its vulnerable packages with advisory, severity and
fixed version, and drops them when the ContainerImage goes away.

The same mechanism verifies rewrite targets: scanning a target on each node
architecture proves it is pullable there, pre-pulls it before rollout, and
shows the fix does not introduce new findings.

This replaces the Trivy operator, which pulls images again from registries,
needs their credentials and scans outside the node's platform.

Open: with kubelet's ensure-secret-pulled-images behavior, a node may refuse
to reuse an image first pulled with credentials for a Pod without them. Verify
on 1.36; if it applies, private images are scanned from a Pod in the
workload's namespace with its pull secrets, or skipped.

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
  cert-manager v1.20.0 on ee-lte-1 shows GHSA-8rvj-mm4h-c258 fixed in 1.20.3.
- An unparsable version or range is shown as unknown or possibly applicable,
  never as drift or as an applicable advisory.
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
