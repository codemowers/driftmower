# Self-service provisioning in driftmower-ui

> **Status:** design doc plus live phase tracker. Phases 1–2 are implemented
> (`lib/features/provisioning/`, `GET /api/provisioning/capabilities`,
> `k8s/rbac.yaml`); phases 3–10 are not started. See **Sequencing** below for
> the phase list, and the tracking issue for current state.
>
> Paths beginning `codemowers-kube/`, `platform-manager/` or `passmower/` refer
> to sibling repos checked out next to this one, not to directories here.
>
> Three findings in this document were verified against live clusters rather
> than reasoned about, and each is load-bearing:
>
> 1. The built-in `admin` ClusterRole reaches **no** custom resource group on a
>    stock cluster, so a sandbox owner bound to it may be unable to apply what
>    this feature generates.
> 2. `sandbox-stack`'s network policies mix an exact-name selector
>    (`cnpg.io/cluster: database`) with a name-agnostic one
>    (`matchExpressions: Exists`), so a Postgres named anything else silently
>    never reports ready.
> 3. Every ZFS StorageClass in `codemowers-kube` omits `volumeBindingMode`,
>    i.e. `Immediate` binding on a node-local provisioner.

## Context

A beginner who wants a PostgreSQL on one of the codemowers clusters today has to know
things that are written down nowhere machine-readable:

- **Which operator is even installed on *this* cluster.** Availability is feature-gated per
  cluster in `codemowers-kube/values.<cluster>.yaml` — `ee-lte-1` has
  emqx/opensearch/redpanda/rabbitmq, the AWS cluster has none of them. Installed across the
  fleet: CloudNativePG (+ barman-cloud plugin), dragonfly-operator, mongodb community
  operator, s3-operator, rabbitmq-cluster-operator, redpanda-operator, opensearch-operator,
  eck-operator, emqx-operator.
- **StorageClasses are per-engine tuned and node-local.** ZFS classes named `postgres`
  (recordsize 32k), `mysql` (16k), `redis` (4k), `mongo`, `minio` (4k), … all
  `provisioner: zfs.csi.openebs.io`, `reclaimPolicy: Retain`. Picking the right one matters,
  and *local* storage means "3 instances" is not the HA a beginner thinks it is.
- **The sandbox namespace has a budget.** `sandbox-stack` renders a `ResourceQuota`
  (smallest size: `requests.storage 10Gi`, `persistentvolumeclaims 5`, `requests.memory 2Gi`,
  `limits.memory 4Gi`, `services.loadbalancers 0`, `services.nodeports 0`) and a `LimitRange`
  defaulting containers to a **256Mi memory limit** — which OOM-kills a PostgreSQL that ships
  without an explicit `resources` block.
- **The namespace is default-deny for both ingress and egress**, and the pre-rendered policies
  are *name-specific*. `platform-manager/charts/sandbox-stack/templates/networkpolicy.yaml`
  hardcodes `podSelector: matchLabels: {cnpg.io/cluster: database}` in its `cnpg-operator`
  NetworkPolicy and in both CiliumNetworkPolicies — so they only match a CNPG cluster named
  **exactly `database`**. Name it `myapp-db` and it gets no operator ingress on 8000, no
  apiserver egress, and (with `egressPolicyEnabled: true`, the platform default) nothing but
  same-namespace traffic and DNS. It never reports ready, with no error that points at the
  cause. Worse, the two Cilium policies are gated on `networkPolicy.cilium.enabled`, which
  defaults to **false** — so on a sandbox with egress policy on and Cilium policies off, CNPG
  cannot work at all until the user adds policies of their own.

  This single interaction is the best argument for the whole feature: it is exactly diagnosable
  from cluster state, and completely undiagnosable from the symptom.

driftmower-ui is already where users look at the cluster, already holds their OIDC session,
already knows their tenancy scope, and already talks to the Kubernetes API. It is the natural
home for "what can I deploy here, and what will bite me". That knowledge is worth at least as
much to an agent as to a human, so it ships twice over one core: as UI views and as a remote
MCP server.

**Decisions taken up front:**

| Decision | Choice |
|---|---|
| MCP hosting | In this repo, remote Streamable HTTP route handlers, passmower bearer auth |
| Write path | **Generate, don't apply.** No write RBAC, no impersonation. Output is annotated manifests + `kubectl` commands + the existing per-tenant kubeconfig |
| Catalog scope | Catalog-driven across every offering whose operator is discovered |

Generate-don't-apply is load-bearing: every new RBAC rule is read-only, there is no
confirm-and-mutate path to secure, and the honest limit of the feature is that it never says
"done" — it says "run this, then come back and watch it come up".

## At a glance

- **One capability layer, two façades.** `lib/features/provisioning/` holds all the knowledge;
  `app/api/provisioning/*` serves the UI and `app/api/mcp` serves agents. Neither façade holds logic.
- **Facts are discovered, never configured.** Aggregated API discovery costs *zero* new RBAC;
  everything else is a read-only `get,list` in one new ClusterRole. Every fact carries
  `{ known }`, and an unreadable fact never silently becomes a pass.
- **A curated recipe per offering**, in TypeScript, grounded in the manifests the team already
  runs — not generated from CRD schemas, which would produce something no beginner can use.
- **The planner is a pure function** `buildPlan(input, facts)`. Its output is *findings* —
  blocker / warning / note, each with what, why and a one-click fix — plus annotated YAML and the
  `kubectl` commands, dry-run first.
- **Four views:** an inventory-plus-catalog home, a six-step guided flow with a constraint rail,
  a per-instance detail page whose URL works *before* the object exists, and a cluster-support
  reference.
- **Ship order:** facts and the reference page first (useful alone, and locally verifiable),
  then the catalog, then Postgres end to end, then the rest of the offerings, then MCP.
- **Two things to settle early**, because they can invalidate work: whether operators ship
  `aggregate-to-admin` roles (phase 2 — decides whether a beginner can apply what we generate),
  and whether real MCP clients can connect to passmower without dynamic client registration.

## Architecture: one capability layer, two façades

```
lib/features/provisioning/       ← the only place the knowledge lives
  facts/         IMPURE. one module per fact family; gatherFacts() is the sole entrypoint
  catalog/       PURE. one Recipe per offering + a partial-patch override loader
  plan/          PURE. buildPlan(input, facts) -> findings, manifests, commands, connection
  types.ts       shared wire types, imported by routes AND client hooks
  authz.ts       namespaces from the token claim + RFC 1123 / injection validation
  mcp/           tool registration + the prose formatter
  use-*.ts       client hooks (no "server-only")

app/api/provisioning/…          ← façade 1: JSON for the UI
app/api/mcp/route.ts            ← façade 2: MCP Streamable HTTP
app/provisioning/…              ← the views
```

Nothing in `plan/` may know it is being called by a browser or by Claude. The MCP tools and the
UI routes are both thin adapters, exactly as `app/api/applications/*/route.ts` is a thin adapter
over `lib/features/applications/*`. The pure/impure split is not stylistic — it is what makes the
planner unit-testable with no Kubernetes at all (see Verification), and it is enforced by the
test runner's inability to resolve the `@/*` alias.

## Discovery: what to read, and what RBAC each read costs

`lib/server/k8s.ts` stays GET-only, with **one** change: thread its existing internal `accept`
parameter out through `kubeApiGet<T>(path, accept = "application/json")`. Aggregated discovery is
content-negotiated, and that one line buys every kind, plural and scope in a single request.
Token memoization, the 401-retry and the `[kube-api]` logging stay untouched. **Do not add
`kubeApiPost`** — the only caller that would want it is `SubjectAccessReview`, which is argued
against below.

Tolerating 403/404 belongs in the feature layer, not the client:

```ts
// lib/features/provisioning/facts/tolerate.ts
export async function optional<T>(p: () => Promise<T>) {
  try { return { ok: true as const, value: await p() } }
  catch (e) {
    if (e instanceof KubeApiError && (e.status === 403 || e.status === 404)) {
      return { ok: false as const, status: e.status }
    }
    throw e
  }
}
```

Every fact therefore carries `{ known: boolean; reason?: "rbac" | "absent" }`, which is what lets
the planner say *"I could not check this"* instead of silently passing. The ClusterRole and the
image roll out independently, so a 403 must degrade a fact, never 500 a page.

| Fact | API path | New RBAC needed |
|---|---|---|
| Served groups, versions, **kinds, plurals and scope** in one call | `GET /apis` with `Accept: application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList` (fallback: `/apis` then per-group) | **None** — discovery is granted to all authenticated principals by `system:discovery` |
| Field schema, *if ever needed* | `GET /openapi/v3/apis/<group>/<version>` | **None** — `/openapi/*` is in the same `system:discovery` rule |
| Operator health + version | `GET /apis/apps/v1/deployments` (already used) | None (already granted) |
| StorageClasses | `GET /apis/storage.k8s.io/v1/storageclasses` | `storage.k8s.io: storageclasses [get,list]` |
| Node capacity, zones, taints | `GET /api/v1/nodes` (already used) | None — but `nodes.ts` currently discards `status.allocatable`, zone labels and taints; extend the mapper |
| Quota headroom | `GET /api/v1/namespaces/<ns>/resourcequotas` | `"": resourcequotas [get,list]` |
| Default container limits | `GET /api/v1/namespaces/<ns>/limitranges` | `"": limitranges [get,list]` |
| Netpol posture | `GET /apis/networking.k8s.io/v1/namespaces/<ns>/networkpolicies` + `GET /apis/cilium.io/v2/namespaces/<ns>/ciliumnetworkpolicies` | `networking.k8s.io: networkpolicies`, `cilium.io: ciliumnetworkpolicies` [get,list] |
| Admission policy | `GET /apis/kyverno.io/v1/clusterpolicies` | `kyverno.io: clusterpolicies,policies [get,list]` |
| PriorityClasses | `GET /apis/scheduling.k8s.io/v1/priorityclasses` | `scheduling.k8s.io: priorityclasses [get,list]` |
| Namespace labels/annotations (sandbox identity, owners) | `GET /api/v1/namespaces` | `"": namespaces [get,list]` |
| **Does the user have rights here** | `GET /apis/rbac.authorization.k8s.io/v1/namespaces/<ns>/rolebindings` | `rbac.authorization.k8s.io: rolebindings [get,list]` |
| **Does their role actually cover this CR** | `GET /apis/rbac.authorization.k8s.io/v1/clusterroles`, `…/namespaces/<ns>/roles` | `rbac.authorization.k8s.io: clusterroles,roles [get,list]` |

Plus: existing database CRs per catalog kind (name collisions, inventory, status), PVCs already
consumed, PodMonitors, Services (for connection hints), and operator pods for CrashLoop
detection — all `get,list`, the last two on RBAC the app already has.

Two deliberate non-choices:

- **Do not read `openAPIV3Schema` from `apiextensions.k8s.io` CRDs.** Discovery already gives
  group, served versions, kind, plural and namespaced-ness — everything the planner branches on.
  The only extra is the schema, and `kubectl apply --dry-run=server` validates fields
  *authoritatively*, including webhooks and quota — and it is already step 1 of the emitted
  commands. A CNPG `Cluster` CRD is a ~700KB GET; doing that for nine offerings is a multi-MB cold
  path to re-derive, worse, what the apiserver already answers. So: **no `apiextensions.k8s.io`
  RBAC at all.** If field-existence checking is ever wanted, `/openapi/v3/apis/<g>/<v>` is
  per-group, ETag'd, gzipped and needs zero RBAC.
- **Do not use any `*SubjectAccessReview`.** `SelfSubjectAccessReview`/`SelfSubjectRulesReview`
  answer for the *pod's ServiceAccount*, which has zero write verbs — they would always say "no",
  about the wrong subject, via a POST. `SubjectAccessReview` with `spec.user` would answer
  correctly but needs `create` on `subjectaccessreviews` (breaking the no-write-RBAC decision,
  and a real capability to probe anyone's permissions) *and* the apiserver's exact username form
  — `https://auth.<region>.codemowers.io/#<sub>`, since these clusters set no
  `--oidc-username-prefix` — so a prefix mismatch yields confidently wrong answers. Minting a
  kubelogin `id_token` and asking as the user would be exact, but we are a different OIDC client
  and cannot obtain one for `aud=default.kubelogin`.

The honest answer is three-part, in this order:

1. **The tenancy claim, which is authoritative for *our* authorization.** `codemowers.io/namespaces`
   comes from platform-manager's `/enrich` over live namespace labels. Namespace not in it →
   refuse. Same primitive `fetchTenantScope()` wraps.
2. **A non-binding hint from RBAC reads.** Find a RoleBinding in the namespace whose subjects
   include `Group: <a token group>` or `User: <usernamePrefix><sub>`, resolve its `roleRef`, and
   check whether the rules cover `create` on the target group/resource. `sandbox-stack` binds
   owners to ClusterRole `admin` (`platform-manager/charts/sandbox-stack/templates/rolebindings.yaml`).
   **Crucially, do not stop there:** the built-in `admin` covers no custom resource except what
   its `aggregationRule` pulls in from ClusterRoles labelled
   `rbac.authorization.k8s.io/aggregate-to-admin: "true"`, which each operator must ship — and
   the vendored rabbitmq-cluster-operator chart in `codemowers-kube` ships no aggregation labels
   at all. Mechanism verified on minikube: `admin` selects `aggregate-to-admin=true`, and a stock
   cluster has only `edit` and `system:aggregate-to-admin` under that label, neither covering any
   CRD. So a sandbox owner bound to `admin` may well be unable to create a `RabbitmqCluster`.

   Because wildcards and aggregation make this approximate, the result type is
   `"likely" | "likely-not" | "unknown"` and it **never produces a blocker** — a warning at most.
   Narrow the RBAC to match: `clusterroles` with `resourceNames: ["admin","edit","view"]`, `get` only.
   **Verify per-operator on ee-lte-1 in phase 2**; upstream CloudNativePG does ship aggregated
   edit/view roles, but it is not vendored here and could not be confirmed offline.
3. **Delegate the real check to the user's own kubectl**, emitted unconditionally as the first
   command: `kubectl auth can-i create clusters.postgresql.cnpg.io -n <ns>`. That *is* a
   SelfSubjectAccessReview, run by the right subject with the right token. Given
   generate-don't-apply, authorization belongs where the apply happens — this is the architecture,
   not a cop-out.

### The ClusterRole to add (`k8s/rbac.yaml`, all read-only)

```yaml
rules:
  - apiGroups: [""]
    resources: ["namespaces", "resourcequotas", "limitranges", "persistentvolumeclaims", "services"]
    verbs: ["get", "list"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "csidrivers"]
    verbs: ["get", "list"]
  - apiGroups: ["scheduling.k8s.io"]
    resources: ["priorityclasses"]
    verbs: ["get", "list"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list"]
  - apiGroups: ["cilium.io"]
    resources: ["ciliumnetworkpolicies"]
    verbs: ["get", "list"]
  - apiGroups: ["kyverno.io"]
    resources: ["clusterpolicies", "policies"]
    verbs: ["get", "list"]
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["podmonitors"]
    verbs: ["get", "list"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["rolebindings"]
    verbs: ["get", "list"]
  # Narrowed on purpose: only to resolve what the sandbox-owners binding grants.
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["clusterroles"]
    resourceNames: ["admin", "edit", "view"]
    verbs: ["get"]
  # Database CRs: existence, name collisions, status.
  - apiGroups:
      ["postgresql.cnpg.io", "barmancloud.cnpg.io", "dragonflydb.io", "mongodbcommunity.mongodb.com",
       "rabbitmq.com", "cluster.redpanda.com", "opensearch.opster.io",
       "elasticsearch.k8s.elastic.co", "apps.emqx.io", "s3.onyxia.sh", "secretgenerator.mittwald.de"]
    resources: ["*"]
    verbs: ["get", "list"]
```

Caching with `createTtlCache` (`lib/utils/ttl-cache.ts`): API surface and storage classes 5 min
(they change only on operator installs), topology 60s, operator health 30s (matching
`hosts.ts`). **Per-namespace facts are deliberately not cached** — quota headroom and name
collisions must be fresh, and it is six small GETs.

Every 403 becomes actionable prose naming `k8s/rbac.yaml`, following `lib/cluster-resources/nodes.ts`'s
`nodeLoadError()` — and a missing read degrades one *fact*, never the whole page: no
StorageClass read means "could not check storage" next to that step, not a dead wizard.

`gatherFacts({ namespace })` is the **only impure entrypoint** in the whole feature. Everything
downstream — catalog and planner — is a total function over injected facts. That split is what
makes the thing testable (see Verification).

## The recipe catalog

A recipe is the join between a discovered kind and a beginner-safe manifest. Recipes live in
**TypeScript** (`lib/features/provisioning/catalog/<offering>.ts`), not YAML data files, for three
reasons in order: `tsc --noEmit` is one of only two verification gates this repo has, and it
checks a typed `Recipe` graph but not a data file; presets need *computation* (quota totals,
storage-class fallback, spread constraints), so recipes are functions; and the Dockerfile copies
only `.next`, `public`, `server.js` and `next.config.ts` — **there is no source tree at runtime**,
so YAML data files would have to be separately copied or bundled anyway.

The escape hatch for per-cluster differences is one optional env var,
`PROVISIONING_CATALOG_OVERRIDES=/etc/driftmower/catalog` (a mounted ConfigMap dir). `catalog/overrides.ts`
lazily reads `*.yaml`, validates each against a zod *partial patch* schema (storage-class
preference, preset numbers, extra companions, disabled offerings) and shallow-merges over the
built-in recipe. An invalid file logs `[provisioning-catalog] <file> -> invalid: …` and is **ignored** — a
bad ConfigMap must never take the app down. That covers the AWS clusters (different control-plane
label, no Cilium CRDs) without forking the image.

```ts
export type OfferingId =
  | "postgres" | "dragonfly" | "mongodb" | "rabbitmq" | "redpanda" | "opensearch" | "elasticsearch" | "emqx" | "bucket"

export type Recipe = {
  id: OfferingId
  purpose: "relational" | "cache" | "document" | "queue" | "stream" | "search" | "mqtt" | "object-store"
  label: string                    // "PostgreSQL"
  blurb: string                    // "A relational (SQL) database. The default choice."
  // Discovery key. Presence of this kind is what makes the offering available.
  serves: { group: string; version: string; kind: string }   // postgresql.cnpg.io/v1 Cluster
  operator: { namespace: string; deployment: string }        // cnpg-system/cnpg-cloudnative-pg
  storageClassPreference: string[]                           // ["postgres", …] then any default
  presets: Record<"dev" | "small" | "ha", Preset>
  companions: (ctx: PlanContext) => Manifest[]  // netpol, PodMonitor, StringSecret, ObjectStore
  requirements: Requirement[]                   // checked by the planner
  connection: (ctx: PlanContext) => ConnectionHint
}
```

Ground each recipe in the manifests the team already runs, so generated output matches house
style rather than upstream README style:

| Offering | Kind | Golden reference and the offering-specific trap the recipe must encode |
|---|---|---|
| PostgreSQL | `postgresql.cnpg.io/v1 Cluster` | `codemowers-kube/tools/templates/database.yaml` (storageClass `postgres` + `PodMonitor`), `platform-manager/deploy/postgres-cnpg.yaml` (pinned `imageName`, zone `topologySpreadConstraints`, explicit `resources`). Prefer `spec.monitoring.enablePodMonitor` over our own PodMonitor, but only when `monitoring.coreos.com` is served. Plus the netpol name trap above |
| Redis-compatible | `dragonflydb.io/v1alpha1 Dragonfly` | `codemowers-kube/kube-system/templates/passmower.yaml` — `authentication.passwordFromSecret` paired with a `secretgenerator.mittwald.de/v1alpha1 StringSecret` so the user never handles a password. Must set `networkPolicyEnabled: false` or the operator writes its own policies that collide with the sandbox bundle; needs `--bind=::`/`--admin_bind=::` on dual-stack |
| MongoDB | `mongodbcommunity.mongodb.com/v1 MongoDBCommunity` | **Needs a ServiceAccount + Role + RoleBinding named `mongodb-database` or the pods never start** — the single most common failure with this operator. Two PVCs (`data-volume` + `logs-volume`), so it costs double against `persistentvolumeclaims`; `scramCredentialsSecretName` is immutable |
| Object storage | `s3.onyxia.sh/v1alpha1 Bucket` (+ `S3User`, `Policy`) | `codemowers-kube/minio/templates/minio.yaml`. Needs `s3InstanceRef: minio/default` — namespaced CR pointing at a cluster-scoped MinIO |
| Message queue | `rabbitmq.com/v1beta1 RabbitmqCluster` | `codemowers-kube/kube-system/templates/rabbitmq-cluster-operator.yaml`. Topology CRs (Vhost/User/Permission) need the *separate* messaging-topology-operator — check both operators independently |
| Kafka | `cluster.redpanda.com/v1alpha2 Redpanda` | The CR embeds a Helm values blob, making it the heaviest by far. `dev` preset only unless ≥3 zones |
| OpenSearch / Elastic | `opensearch.opster.io/v1 OpenSearchCluster`, `elasticsearch.k8s.elastic.co/v1 Elasticsearch` | Node-pool roles must be spelled out; memory floors fail the smallest sandbox quota outright |
| MQTT | `apps.emqx.io/v2beta1 EMQX` | The version moves; declare `versions: ["v2beta1", "v2alpha1"]` and let the planner pick a served one |

**Version negotiation is how the catalog fails safe.** Each recipe declares its supported
versions, preferred first; the planner intersects with discovery's *served* versions and picks
the first match. No match is a blocker with a real explanation — *"this cluster serves
`apps.emqx.io/v2alpha2`, which this catalog doesn't know; the operator is newer or older than
expected"* — instead of emitting a manifest the apiserver rejects.

Backups get first-class treatment for Postgres: the barman-cloud plugin
(`cnpg-plugin-barman-cloud` v0.6.0) is installed, so the `ha` preset emits a
`barmancloud.cnpg.io ObjectStore` plus the s3-operator `Bucket`/`S3User`/`Policy` it writes to —
and "no backup configured" is a standing warning on `dev`/`small`. If the backup CRDs are absent,
degrade to no-backup with a warning rather than failing the plan.

Cluster-specific values (`controlPlaneLabelKey` differs: `node-role.kubernetes.io/control-plane=true`
on k3s vs `codemowers.cloud/node-role=control-plane` on AWS) are **derived, not configured** —
read the node labels and pick, rather than adding an env var per cluster.

## The planner

`plan(recipe, target, inputs) → PlanResponse` (shape under **Wire shapes** below). It is pure:
facts in, findings and manifests out — no I/O of its own, which is what makes it unit-testable.

The findings are the product. Grounded in the real sandbox constraints:

| Finding | Severity | Triggered by |
|---|---|---|
| "3 instances on `postgres` storage is not multi-node HA — `zfs.csi.openebs.io` volumes are node-local, so each instance is pinned to the node that first scheduled it" | warning | storage class provisioner is local (`topolvm`/`zfs.csi.openebs.io`) and `instances > 1` |
| "This needs 60Gi of PVC but the namespace quota allows 10Gi in total; the apply is rejected whole, not partially" | **blocker** | `requests.storage` in `ResourceQuota` minus current usage |
| "The namespace's LimitRange defaults containers to a 256Mi memory limit. PostgreSQL will be OOM-killed unless the manifest sets `resources` explicitly — it does below" | note | `LimitRange` present |
| "This namespace's network policies only cover a CNPG cluster named `database`. Named `myapp-db` it gets no operator ingress on 8000 and never reports ready" | see below | a netpol/CNP in the namespace selects `cnpg.io/cluster: <other name>` and none matches the requested name |
| "The namespace denies egress by default and CNPG must reach the Kubernetes API" | see below | `default-deny-egress` present, no matching apiserver-egress policy |
| "The namespace denies ingress by default and CNPG's health probes come from the node, not a pod, so a pod-selector policy cannot admit them" | see below | default-deny ingress present, no `fromEntities: [host, remote-node]` policy matching |
| "Only one zone is labelled on this cluster, so `topologySpreadConstraints` cannot spread anything" | warning | distinct `topology.kubernetes.io/zone` values < requested instances |
| "No backup is configured. barman-cloud is installed here — switch to the HA preset or add an ObjectStore" | warning | postgres recipe, non-`ha` preset |
| "You are namespace-admin in `sandbox-foo`, but no role visible to us covers `postgresql.cnpg.io` — the built-in `admin` only covers CRDs whose operator labels a role `aggregate-to-admin`. Run the `can-i` command below to be sure" | warning (never a blocker) | bound role's aggregated rules do not match the recipe's group/resource |
| "The storage class binds volumes immediately, and it is node-local — a volume can bind on a node the pod then can't be scheduled to" | warning | local provisioner and `volumeBindingMode` unset or `Immediate` (true of *every* ZFS class in `codemowers-kube`) |
| "`reclaimPolicy: Retain` — deleting the database leaves the volume, the data, and the quota consumption behind" | warning | storage class `reclaimPolicy: Retain` |
| "`allowVolumeExpansion: false` — this size is final, so pick it now" | warning | storage class |
| "This cluster serves `apps.emqx.io/v2alpha2`, which this catalog doesn't know" | **blocker** | recipe versions ∩ served versions = ∅ |
| "A `<kind>` named `<name>` already exists in this namespace" | **blocker** | name collision |
| "Kyverno policy `<name>` in Enforce mode matches this kind and namespace; the dry-run will tell you for certain" | warning | matching Enforce-mode Kyverno rule — we do not evaluate its CEL/JMESPath |
| "`services.loadbalancers: 0` in this namespace — you cannot expose this database outside the cluster" | note | quota |
| "No PodMonitor means no metrics in the sandbox Prometheus — one is included below" | note | prometheus-operator CRDs discovered |
| "The operator is running but reports 0/1 ready — manifests would apply and nothing would act on them" | **blocker** | operator Deployment `readyReplicas < 1` or its pods CrashLooping |
| One per unreadable fact: "Quota could not be read (403), so this is unchecked" | note | any fact with `known: false` |

Each `Finding` carries a stable machine `code` (`quota.requests-memory`, `netpol.cnpg-name-mismatch`,
`storage.local`, …) so the UI can anchor to it, the MCP client can branch on it, and tests can
assert on it without matching prose.

**Name and namespace validation is an injection boundary, not a nicety.** Both strings land
inside a rendered YAML document *and* inside a shell heredoc the user pastes into a terminal.
Validate against RFC 1123 (`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, ≤53 chars) and against the tenancy
claim **before** rendering anything, as blockers.

**Our quota arithmetic will sometimes disagree with the apiserver** — LimitRange injection,
operator-spawned jobs, sidecars. Always label it an estimate, and never let a quota estimate be
the only blocker without adding "the dry-run will confirm this".

**Netpol detection must handle two selector shapes.** As of the current `sandbox-stack`, the
three older policies (`cnpg-operator` ingress on 8000, and the Cilium `database-health-probes` /
`database-kube-apiserver`) select `matchLabels: {cnpg.io/cluster: database}` — exact-name, hence
the trap. The newer native `apiserver-egress-cnpg` selects
`matchExpressions: [{key: cnpg.io/cluster, operator: Exists}]` — name-agnostic, so it covers any
instance name, but it is rendered **only when `apiserverEgress.cidrs` is non-empty**, and the
chart default is empty. So the matcher has to evaluate both shapes, and "egress isolation is on,
no apiserver-egress policy exists in either shape" is a real and currently-default blocker.

**The three network findings are severity-conditional, and the rule matters.** If Cilium CRDs
are discovered, we *generate* the missing policies as part of the plan, so each is a **warning**
("applies once you include the policy below") — and toggling that optional object off in the
apply step promotes it back to a **blocker**. If Cilium CRDs are absent (the codemowers AWS
clusters run AWS VPC CNI, which is exactly why `sandbox-stack` defaults
`networkPolicy.cilium.enabled: false`), we cannot generate a policy that admits node-sourced
health probes at all, and it stays a **blocker** with the honest reason. That asymmetry is worth
surfacing rather than smoothing over: it teaches the user what the generated object is *for*.

Kyverno matching is a best-effort *lint*, not an admission simulation — we cannot run the
admission chain without a `create` verb. Say that in the copy ("checked against the cluster's
policies; the API server has the final word") and put the real verdict in the user's hands. Every
command carries a `why`, because a beginner pasting commands they don't understand is how this
feature fails:

```bash
# 1  cluster access — kubectl talks to the apiserver as YOU, not as driftmower
export KUBECONFIG=~/Downloads/kubeconfig-sandbox-foo.yaml

# 2  confirm you're allowed — only your own token can answer this
kubectl auth can-i create clusters.postgresql.cnpg.io -n sandbox-foo

# 3  validate, changing nothing — runs CRD schema, admission webhooks, Kyverno and quota
kubectl apply --server-side --dry-run=server -n sandbox-foo -f database.yaml

# 4  apply
kubectl apply --server-side -n sandbox-foo -f database.yaml

# 5  watch it come up
kubectl -n sandbox-foo get cluster database -w
```

Step 3 is *why* our quota and policy checks are allowed to be approximate: the apiserver is the
source of truth and the user runs it before mutating anything. The plan must say so, and must
also state the dry-run's own limit — *"it does not tell you whether a volume will ever find a
node"* — which is exactly the gap our scheduling findings fill.

## Manifest rendering: no new dependency

`lib/features/yaml/yaml-lines.ts` already emits `YamlLine[]` with an `annotate` callback and a
per-line `note`, and `app/components/document-viewer.tsx:149` already renders those notes
inline in italics. So a recipe supplies a `notes: Record<jsonPath, string>` map, the planner
turns it into a `YamlAnnotator`, and the generated manifest **teaches in place**:

```yaml
storage:
  storageClass: postgres        # tuned for Postgres (ZFS recordsize 32k); node-local
  size: 5Gi                     # counts against requests.storage 10Gi in this namespace
```

Multi-document output = `emitYamlLines()` per doc joined with `textLines("---")`, and
`yamlText(lines)` (already exported from the same module) collapses that back to the plain string
the MCP tools and the `kubectl` heredoc need. So one renderer serves both façades and **no YAML
dependency ships to production**; `CopyButton` and the viewer's download path come for free.

The risk in reusing it is that `yaml-lines.ts` was written to *display* Kubernetes objects, not
to round-trip them — it handles scalar quoting but has never been asked to emit, say, Redpanda's
embedded Helm values blob. So pin that down with a test rather than an assumption: add `js-yaml`
as a **devDependency** only, and have the golden-manifest test `loadAll()` every rendered bundle
and deep-compare against the source objects. If a case fails, fix `yaml-lines.ts` (a win for the
existing YAML pages too) or fall back to `js-yaml` in production for that path.

## The MCP server

Add `@modelcontextprotocol/sdk` (1.30.0 verified available) and declare `jose` explicitly (today
only a transitive dep of `openid-client`).

**Transport: stateless.** Use `WebStandardStreamableHTTPServerTransport` (SDK ≥ 1.26), which takes
a `Request` and returns a `Response` — exactly the App Router contract, no Node req/res adapter:

```ts
// app/api/mcp/route.ts
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(req: Request) {
  const auth = await verifyMcpToken(req)
  if (!auth.ok) return unauthorized(auth.reason)   // 401 + WWW-Authenticate w/ resource_metadata
  const server = buildMcpServer()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // plain JSON; nothing here streams
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(req, { authInfo: auth.info })
  } finally {
    await server.close()
  }
}
export async function GET()    { return new Response(null, { status: 405, headers: { Allow: "POST" } }) }
export async function DELETE() { return new Response(null, { status: 405, headers: { Allow: "POST" } }) }
```

Stateless is the right call, not a shortcut: a single replica that skaffold restarts on every
push would drop sessions anyway; every tool is a pure read over TTL-cached facts, so there is no
session state worth keeping; and refusing the long-lived `GET` SSE stream avoids parking
connections in Traefik on a one-replica pod. The cost is no `tools/list_changed` and no
resumability — neither matters for read-and-plan tools. `authInfo` reaches handlers as
`extra.authInfo`, which is how the caller's `sub`, `groups` and namespaces claim get into
`authz.ts` **without module-level request state** — critical, since module singletons are shared
across concurrent requests.

**Getting past `proxy.ts`** — and one sharp edge. The exempt branch must match `/api/mcp`
**exactly**, not by prefix:

```ts
if (pathname.startsWith("/api/auth/") || pathname === "/api/mcp" || pathname.startsWith("/.well-known/")) {
  return NextResponse.next()
}
```

`startsWith("/api/mcp")` would also un-gate `/api/mcp/token`, which must stay behind the session
cookie. `/api/mcp` does its own bearer verification and must not hit the cookie gate — an MCP
client has no cookie and would get proxy.ts's 401 JSON, which is not MCP-shaped and carries no
`WWW-Authenticate`.

**Metadata via rewrites, not a dot-directory.** Per RFC 9728 the document for resource
`https://host/api/mcp` lives at `https://host/.well-known/oauth-protected-resource/api/mcp` — at
the root, with the resource path appended. Dot-prefixed segments under `app/` are fragile across
Next versions, and the custom `server.js` makes routing surprises expensive to debug, so use
`next.config.ts` rewrites onto a normal route:

```ts
async rewrites() {
  return [
    { source: "/.well-known/oauth-protected-resource", destination: "/api/well-known/oauth-protected-resource" },
    { source: "/.well-known/oauth-protected-resource/api/mcp", destination: "/api/well-known/oauth-protected-resource" },
  ]
}
```

Every 401 from `/api/mcp` must carry
`WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<APP_BASE_URL>/.well-known/oauth-protected-resource/api/mcp"`
— that header is how an OAuth-capable client discovers the flow at all.

**Audience: a new one, and strictly checked.** `MCP_AUDIENCE`, default `https://driftmower-mcp`.
Strictness is load-bearing: without it, the ordinary UI access token that any browser session
holds would open the MCP server. No new *scope* is needed — `namespaces` already carries the
claim, and resource indicators are not scopes. (Inventing a `provisioning` scope would need a change
in passmower's own hardcoded `scopes:` array plus a re-login for every user. Not worth it.)

**`MCP_ENABLED` defaults to `false`, and that default is deliberate.** The MCP resource indicator
must be appended in `app/api/auth/login/route.ts` — a resource absent from the original grant
fails the later refresh with `invalid_target`. But if passmower rejects a third `resource`,
**login breaks for every user**, not just MCP. So gate it, verify on a deployed build, and keep
the rollback to unsetting one variable.

**JWKS verification, the gotcha already paid for once.** passmower's `jwks_uri` returns keys with
no `kid` and no `alg`, while oidc-provider signs with the RFC 7638 thumbprint as `kid`, so
`createRemoteJWKSet` never matches and every token fails. Stamp it locally in a new
`lib/auth/jwks.ts`:

```ts
const keys = await Promise.all(raw.keys.map(async k => ({
  ...k, kid: k.kid ?? (await calculateJwkThumbprint(k)), alg: k.alg ?? "RS256",
})))
return createLocalJWKSet({ keys })
```

Deliberately **not** `createTtlCache` here: key rotation needs invalidation, which that helper has
no notion of. Use a 10-minute TTL plus `invalidateKeySet()`, and mirror `k8s.ts`'s shape — on
`errors.JWKSNoMatchingKey`, invalidate and retry exactly once. Verify `issuer` exactly (trailing
slash included), `audience: mcpAudience()`, `algorithms: ["RS256"]`, `clockTolerance: 60`.

**Two ways for a client to get a token:**

1. **Paste one (quick start).** A session-gated `/api/mcp/token` route mints an MCP-audience token
   via `refreshTokenGrant(config, session.refreshToken, { resource: mcpAudience() })` — a near-copy
   of `getPlatformManagerToken`, with its own in-process Map keyed by refresh token and the same
   re-key-on-rotation block. A small settings panel shows it with the existing `CopyButton` and the
   exact `claude mcp add --transport http driftmower <APP_BASE_URL>/api/mcp --header "Authorization: Bearer …"`
   line. Print the honest caveat next to it: **the token expires in about an hour.** This is for
   trying it out.
2. **OAuth (durable).** Protected-resource metadata pointing at passmower, plus a second,
   **public** `OIDCClient` CR (`driftmower-mcp`, `pkce: true`, `tokenEndpointAuthMethod: none`,
   loopback + client redirect URIs). Clients that let you supply a client id — Claude Code,
   Cursor, Claude custom connectors — then do PKCE and refresh themselves.

**Client onboarding is the largest unknown, and must be stated plainly:** passmower has **no
dynamic client registration** (`features.registration` is absent from its `configuration.js`), so
a strict DCR-only client will not connect even with perfect metadata. `features.deviceFlow` *is*
enabled, which gives a headless fallback. Probe this with a throwaway endpoint early rather than
discovering it at the end of phase 9 — the answer decides how much of that phase is worth doing.

**Authorization inside tools** comes from the token claim, full stop — no platform-manager call,
since the MCP token has the wrong audience for it and this flow holds no refresh token. Known
narrowing to document rather than paper over: the claim carries *sandbox* namespaces, while
`fetchTenantScope()` also returns app namespaces, so `foo-<app>` namespaces will report "not
allowed". The fix is one env var in a sibling repo — add `https://driftmower-mcp` to
platform-manager's `API_AUDIENCES` — after which `/api/tenants` accepts the MCP token directly.

One audit line per call: `console.log("[mcp] tool=plan_provision sub=<sub> ns=<ns> offering=postgres -> ok(blockers=0)")`.

**Tools.** Every one carries `annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
— *including the planners*, which only render text. Nothing in this server writes.

| Tool | Kind | Returns |
|---|---|---|
| `list_offerings` | read | Every recipe with `available` and, when false, *why* ("the dragonfly-operator is not installed on this cluster") |
| `describe_cluster_capabilities` | read | Storage classes (local-vs-network, expansion, reclaim, binding mode), zones, node headroom, priority classes, which network-policy engine is present, per-operator readiness and version |
| `describe_namespace_readiness` | read | One namespace: quota used/hard/free, LimitRange, default-deny posture, existing instances, `mayCreate: likely \| likely-not \| unknown`, and `unknownFacts[]` |
| `list_instances` | read | Provisioned CRs in scope, with readiness, storage and whether a backup is configured |
| `plan_provision` | plan | The full plan: annotated manifests, findings, commands, connection hints |
| `plan_network_policies` | plan | Just the companion policies for an *existing* instance — the fix for "my database exists but never goes Ready", which is the single most likely support ticket on these clusters |
| `plan_backup` | plan | ObjectStore + Bucket/S3User/Policy plus the CR patch that references them |
| `explain_storage_class` | read | One class in plain language: local? pinned to a node? growable? does deleting the instance keep the data? |
| `get_instance_status` | read | One instance: readiness, pod state, PVC usage, recent events, how to connect |

Plus one MCP **prompt**, `provision-a-service`, chaining capabilities → offerings → namespace
readiness → plan → dry-run, so a beginner does not have to know the tool order.

**Result shape is where "aimed at beginners" is won or lost.** Each tool returns
`content: [{ type: "text", text: <markdown> }]` **and** `structuredContent` matching its
`outputSchema`. The text is written for a human reading a chat:

```
## PostgreSQL, small, in sandbox-foo — 1 blocker, 3 warnings

**Blocker — not enough memory quota.** This namespace allows 2Gi of requests.memory
and 1.4Gi is already used. This plan needs 1Gi. The `dev` preset needs 256Mi and fits today.

**Watch out — your storage is local to one node.** StorageClass `postgres` uses
zfs.csi.openebs.io, so the volume lives on one machine's disks. Three instances still
means three copies of the data, but if that node reboots, that instance is down until it
comes back. Storage is not what makes this HA.
```

Rules for `mcp/format.ts`: lead with the verdict and a count; one short paragraph per finding
saying *why it bites*; the YAML appears exactly once, inside the command that uses it;
`structuredContent` carries the machine view so a model can chain without re-reading prose. **No
raw JSON in the text channel.**

**One security line to hold.** The ServiceAccount already has cluster-wide `secrets: list`, which
returns values, not just names. This feature must not widen that and must never read connection
values — emit `kubectl get secret … -o jsonpath` for the user to run instead. Put it in the README
so the choice stays legible later.

Tool results must read as prose with the manifest and the next command, not as a JSON dump — an
agent relaying "blocked: the namespace quota allows 10Gi, you asked for 60Gi" is the whole
point. Return a short markdown `content` block plus `structuredContent` for the machine.

## The UI views

Route registration is one entry in `navItems` (`app/components/core/nav-bar.tsx`) — listed
unconditionally, with the page owning its own "not configured" state, per the existing comment
above `Tenants` — plus a `<SectionLinkCard>` on `app/executive-summary/page.tsx`.

| Route | Purpose |
|---|---|
| `app/provisioning/page.tsx` | Home. Three stacked sections (sections, not tabs — tabs are a detail-page idiom in this repo): **What you have** (ROW_GRID inventory), **Provision something** (offering catalog by purpose), **What this cluster gives you** (4 `StatCell`s → reference) |
| `app/provisioning/new/page.tsx` | The guided flow |
| `app/provisioning/[namespace]/[resource]/[name]/page.tsx` | Detail, keyed kubectl-natively (`/provisioning/sandbox-foo/clusters.postgresql.cnpg.io/orders-db`). CRs have no uid registry, so the repo's `[uid]` habit does not apply; this shape makes `kubectl get <resource> -n <ns> <name>` derivable from the URL |
| `app/provisioning/cluster-support/page.tsx` | Canonical constraints reference with per-row anchor ids, linked from every finding. Also the platform team's debugging surface |

**Where constraint knowledge lives** — the reference page is necessary but nobody should *have*
to read it. Three placements, in order of importance:

1. **Findings** attached to the step where the fix lives, quoting the actual cluster fact.
2. **A constraint rail** in the right column of every wizard step (`grid xl:grid-cols-[minmax(0,1fr)_360px]`,
   the pattern already on `app/cluster/page.tsx`), showing only the facts relevant to *that*
   step. This is the reference material people actually read, because it sits beside the choice.
3. **The reference page**, for the facts a wizard has no reason to show (all Kyverno rules, every
   zone, priority classes) and for `Learn more` anchors.

**The guided flow** — six steps, three of which pass on defaults. Step chrome is a numbered
`StepRail`, not `TabBar`: steps are ordered, gated, and must show a per-step attention dot when
a later choice invalidates an earlier one.

| # | `step=` | Decides | Constraints surfaced here |
|---|---|---|---|
| 1 | `offering` | what to provision | operator availability/health, "what it needs" |
| 2 | `where` | namespace + name | quota headroom for that namespace, network posture, permission verdict, name collision, **and the netpol name-match trap** |
| 3 | `size` | preset, instances, storage size + class | local-storage-vs-replicas, zone count, node allocatable, quota arithmetic, expansion |
| 4 | `options` | version, backup, monitoring, priority class | operator-supported versions, whether an S3 target was discovered, prometheus-operator present |
| 5 | `review` | nothing | every finding, resolved values, the object list. Blockers gate Continue |
| 6 | `apply` | nothing | manifests, commands, kubeconfig, then-what |

Purpose is a `FilterChips` row inside step 1 rather than a step of its own. Offering cards also
carry a fast path — `[Dev preset →]` jumps straight to `step=review` — for the beginner who
just wants something running.

`PageHeader`'s subtitle restates the promise on **every** step: *"Nothing is created until you
run kubectl yourself."* A beginner should never be afraid to click.

**Findings are the product.** Each renders as four parts, and this is the teaching mechanism:

```
[BLOCKER]  3 instances cannot fit on 2 nodes with local storage
 what  The `postgres` class is zfs.csi.openebs.io, WaitForFirstConsumer and node-local.
       Each instance needs its own node; this cluster has 2 schedulable nodes in 1 zone.
 why   A node-local volume can only be mounted by a pod on that node, so CNPG can never
       move an instance if that node goes down.
 fix   [Use 2 instances]   [Show cluster storage →]
```

`fix` buttons are pure URL-param patches (`{ instances: "2" }`), so they are trivial to
implement and never a dead end. Inline beside a control, a finding collapses to its title with
the what/why in a `Popover` (installed). Severities map to existing tokens via a new
`lib/features/provisioning/finding-style.ts` mirroring `lib/cluster/styles/status-style.ts`:
`status-major` blocker / `status-minor` warning / `status-neutral` note. A disabled `Next`
**always** carries its reason beside it — never a bare disabled button.

Copy rules, worth enforcing in review:

1. Title states the **consequence**, not the rule ("3 instances cannot fit…", not "Invalid replica count").
2. Detail names the **real object** (`postgres`, `WaitForFirstConsumer`, `ResourceQuota sandbox-quota`) so the sentence is greppable and checkable with kubectl.
3. `why` is one sentence of transferable principle.
4. Fix labels name the new value ("Use 2 instances", never "Fix this").
5. Numbers carry unit and ceiling: "20Gi of 10Gi allowed in `sandbox-foo`".
6. Never "not allowed" without an actor: "`ResourceQuota sandbox-quota` allows 10Gi".
7. **A degraded read names the literal error the user will hit**: "Quota could not be read, so
   this is unchecked. If it is smaller than 20Gi, `kubectl apply` fails with `exceeded quota`."
   This is the highest-value teaching move available — it makes the future failure
   self-diagnosing.
8. No exclamation marks, no "Oops", no emoji.

**Governing rule for degraded reads:** an unreadable fact must never silently become a pass. The
server downgrades the affected blocker to a warning and marks it `degradedFrom: "blocker"`, and
the copy says what went unchecked. Never hide the step.

**The offering picker for someone who has never heard of "cnpg."** Title is the product
("PostgreSQL"); one plain-words "what it is" plus a `Good for:` list; the operator is an
implementation detail on a `via CloudNativePG · Cluster (postgresql.cnpg.io/v1)` line, with the
kind in mono so the user can connect wizard output to `kubectl get cluster`. Operator health is
honest about the states that actually happen:

| State | Chip | Tooltip |
|---|---|---|
| `ready` | `Operator ready 1.24.1` | version + watched namespaces |
| `degraded` | `Operator degraded` | "The controller Deployment has 0/1 pods ready. Manifests would apply but nothing would act on them." |
| `crds-only` | `No controller` | "The CRDs exist but no controller is running. `kubectl apply` succeeds and the object sits there forever." |
| `not-installed` | `Not installed` | "Nothing on this cluster understands this kind yet." |

Not-installed offerings still render (dimmed, sorted below, under a `Not available on this
cluster` heading) with two live actions and no dead end: `[What it needs]` in a Popover, and
`[Preview manifests]` → read-only `step=review` topped with *"Nothing will happen until
CloudNativePG is installed. `kubectl apply` fails with `no matches for kind "Cluster" in version
"postgresql.cnpg.io/v1"`. Send this page to whoever runs the cluster."* This is the **default
experience on minikube**, so it must look intentional.

**The apply step**, in order: object list (ROW_GRID `Kind | Name | What it does | Why it's
here`, optional objects carrying a `Switch` that re-plans), the annotated multi-document YAML in
`DocumentViewer`, the commands, the kubeconfig, then-what.

Commands are server-supplied so they cannot drift from the manifest, rendered with the
label/`<code>`/`CopyButton` row idiom, and injected with `--kubeconfig kubeconfig-<tenant>.yaml`
so they match the file `KubeconfigPanel` just downloaded:

```
dry-run   kubectl apply --server-side --dry-run=server -f orders-db.yaml
apply     kubectl apply --server-side -f orders-db.yaml
watch     kubectl get clusters.postgresql.cnpg.io -n sandbox-foo orders-db -w
password  kubectl get secret -n sandbox-foo orders-db-app -o jsonpath='{.data.password}' | base64 -d
```

The dry-run row carries its own limit: *"The API server checks the schema, admission webhooks
and Kyverno policies. It does not tell you whether a volume will ever find a node."*

**"Then what?" is where generate-don't-apply stops being a compromise.** The detail page URL
works *before the object exists*: it renders "Nothing named `orders-db` exists in `sandbox-foo`
yet. It will appear here within a few seconds of `kubectl apply`." and polls every 10s, flipping
to the live view by itself. So the user gets a `[Track orders-db]` link at the end of the wizard
and watches their database come up in the UI — with zero mutation from us.

**Wizard state is URL params only**, no store: `?step=size&offering=postgres&ns=sandbox-foo&preset=small&instances=1&size=5Gi&sc=postgres`.
Refresh survival and deep-linking are free, and "here is my exact config, look at the blockers"
becomes a link a beginner can paste to their platform team. One new hook,
`use-wizard-params.ts`, encodes the split the repo already implies: **step changes use
`router.push`** (browser Back = previous step), **field changes use `history.replaceState`** (per
`use-tab-param.ts`, so typing doesn't spam history). `use-plan.ts` forwards
`useSearchParams().toString()` straight to `GET /api/provisioning/plan?…` debounced 250ms — which
also makes the endpoint pasteable into a browser for debugging. Do **not** add wizard params to
`CARRY` in `use-context-href.ts`; they would leak into every cross-page link.

**New shadcn primitives: none**, deliberately. Presets and instance counts are `role="radiogroup"`
rows built from `Button` + `aria-checked` (precedent: `FilterToggle` hand-rolls
`role="checkbox"`); the namespace and version pickers are `DropdownMenu` + `DropdownMenuRadioGroup`
(precedent: `app/topmost-owners/components/focus-select.tsx`); disclosure is `useState` +
`ChevronRight` (precedent: `commands-card.tsx`); "why" uses the installed `Popover`. The only two
text inputs get a ~25-line local `text-field.tsx` styled after `FilterSearchInput`. No modal, and
explicitly **no slider** for storage size — a continuous control that can land on an invalid
value is actively wrong for a beginner.

**One extraction worth doing:** `app/components/command-row.tsx`. The label/`<code>`/`CopyButton`
row is already duplicated in `topmost-owners/[uid]/components/commands-card.tsx`,
`[podUid]/components/commands-card.tsx` and `components/actions-card.tsx`; the apply step needs a
fourth. Extract once, reuse in all four.

**Empty and degraded states** (all must look intentional, because most are what minikube shows):

| Condition | Copy |
|---|---|
| Not in-cluster | "Provisioning reads what this cluster supports from the Kubernetes API, which is unavailable when not running in-cluster." (mirrors `NOT_IN_CLUSTER` on `app/cluster/page.tsx`) |
| No operators discovered | Keep the heading, show the **full dimmed catalog**: "No operators are installed on this cluster, so there is nothing to provision yet. The catalog below shows what each offering needs — send one to your platform team." Never an empty page |
| platform-manager not configured | Namespace step falls back to a free-text field: "Tenant management is not configured for this cluster, so namespaces cannot be listed. Type the namespace you have access to." — still validated against the quota read |
| Tenants exist, none selected | "Pick a tenant in the sidebar to list your namespaces" |
| Scope matches no instances | `<TenantEmptyState tenants={…} entity="provisioned services" />` |
| A new read 403s | One string per source, shaped exactly like `nodeLoadError` in `lib/cluster-resources/nodes.ts`: "Not authorized to list storage classes (403). The driftmower-ui ServiceAccount needs get/list on storageclasses — add a cluster-scoped RBAC rule (see `k8s/rbac.yaml`) and redeploy." |
| Operator `crds-only`/`degraded` | Warning on review: "applies, then nothing happens" |

## Files

**New — server (`import "server-only"` where it touches the API)**
```
lib/features/provisioning/{types,constants}.ts
lib/features/provisioning/plan/{requirements,render,commands,connect,index}.ts
lib/features/provisioning/catalog/{types,index,overrides,postgres,dragonfly,mongodb,rabbitmq,redpanda,opensearch,elasticsearch,emqx,bucket}.ts
lib/server/mcp/{server,auth,tools}.ts
app/api/provisioning/{capabilities,plan,instances}/route.ts
app/api/provisioning/instances/[namespace]/[resource]/[name]/route.ts
lib/features/provisioning/facts/{tolerate,discovery,operators,storage,topology,namespace,policy,index}.ts
lib/features/provisioning/{authz,mcp/server,mcp/format}.ts
lib/auth/{jwks,mcp-token}.ts
app/api/mcp/route.ts
app/api/mcp/token/route.ts                          (stays behind the session gate)
app/api/well-known/oauth-protected-resource/route.ts  (reached via rewrite)
k8s/mcp-oidcclient.yaml
```

**New config**, documented in all three places per repo convention (README tier table,
`.env.example`, `k8s/deployment.yaml`):

| Var | Default | Purpose |
|---|---|---|
| `MCP_ENABLED` | `false` | Serves `/api/mcp` and appends the MCP resource indicator at login. Off by default because a resource indicator passmower rejects breaks *login*, not just MCP |
| `MCP_AUDIENCE` | `https://driftmower-mcp` | RFC 8707 resource indicator, and the `aud` strictly verified on every MCP request |
| `PROVISIONING_CATALOG_OVERRIDES` | unset | Directory of YAML recipe patches (ConfigMap mount); invalid files logged and ignored |

**New — client**
```
lib/features/provisioning/{finding-style,purposes,manifest-lines}.ts
lib/features/provisioning/{use-capabilities,use-plan,use-instances,use-instance,use-wizard-params}.ts
app/components/command-row.tsx                      (extraction; replaces 3 duplicates)
app/provisioning/page.tsx + components/{offering-card,instance-row,operator-status-chip,cluster-support-strip}.tsx
app/provisioning/new/page.tsx + components/{step-rail,step-offering,step-where,step-size,step-options,step-review,step-apply,finding-list,finding-block,constraint-rail,choice-rows,storage-class-rows,quota-headroom-bar,text-field,object-list,then-what}.tsx
app/provisioning/[namespace]/[resource]/[name]/page.tsx + components/{waiting-card,overview-tab,connect-tab,storage-tab,manifest-tab}.tsx
app/provisioning/cluster-support/page.tsx + components/  (one anchored table per fact family)
```

**Modified**
```
k8s/rbac.yaml                       one ClusterRole + binding for the read-only rules above
proxy.ts                            exempt /api/mcp (exact match) and /.well-known/
next.config.ts                      two rewrites for the protected-resource metadata
app/api/auth/login/route.ts         append the MCP resource indicator when MCP_ENABLED
lib/server/k8s.ts                   thread the `accept` override out of kubeApiGet
app/components/core/nav-bar.tsx     one navItems entry, { name: "Provisioning", href: "/provisioning", icon: PackagePlus }
app/executive-summary/page.tsx      one SectionLinkCard
lib/cluster-resources/nodes.ts      keep allocatable, zone labels and taints (currently discarded)
package.json                        + @modelcontextprotocol/sdk, + jose (explicit)
README.md, .env.example, k8s/deployment.yaml   env/scope documentation, per repo convention
```

Ignore `app/export/components/create-sandbox.tsx` — a static mock whose premise (a button that
provisions) contradicts generate-don't-apply. Don't extend it, don't link to it, don't delete it
here.

## Wire shapes

The full set is in the server layer's `types.ts`; the load-bearing ones:

```ts
type Availability =
  | { state: "ready"; version: string | null; watchedNamespaces: string[] | "all" }
  | { state: "degraded"; version: string | null; reason: string }
  | { state: "crds-only"; reason: string }
  | { state: "not-installed"; installHref: string | null }

type StorageClassFact = {
  name: string; provisioner: string; isDefault: boolean
  bindingMode: "Immediate" | "WaitForFirstConsumer"
  allowExpansion: boolean; accessModes: ("RWO" | "RWX" | "ROX")[]
  topology: "node-local" | "zonal" | "cluster-wide" | "unknown"
  implies: string        // ONE beginner-facing clause
  replicaSafe: boolean   // can two instances live here and still move?
}

type Finding = {
  id: string
  severity: "blocker" | "warning" | "note"
  step: "offering" | "where" | "size" | "options" // where the fix lives
  title: string    // the consequence, <= 70 chars
  detail: string   // the mechanism, naming real objects
  why: string      // one transferable sentence
  fixes: { label: string; patch: Record<string, string | null> }[]
  learnMore?: { label: string; href: string }     // /provisioning/cluster-support#sc-postgres
  degradedFrom?: "blocker"                        // an unreadable fact forced a downgrade
}

type PlanObject = {
  index: number; kind: string; apiVersion: string; name: string; namespace: string
  role: "primary" | "secret" | "policy" | "monitor" | "backup" | "config"
  does: string; why: string
  optional: boolean; includedBy?: string          // the param that toggles it
  object: Record<string, unknown>                 // fed to emitYamlLines
  notes: Record<string, string>                   // jsonPath -> inline YAML note
}

type PlanResponse = {
  ok: boolean            // false when any blocker
  preview: boolean       // operator missing: read-only preview
  resolved: { instances: number; storageGi: number; storageClass: string; version: string }
  choices: Record<"instances" | "storageClass" | "storageGi" | "version", Choice<unknown>>
  findings: Finding[]
  objects: PlanObject[]
  commands: { label: string; value: string; hint?: string }[]
  readySignal: { humanText: string; watchCommand: string }
  connect: { secretName: string; serviceName: string; passwordCommand: string; dsnHint: string }
  trackHref: string; filename: string
  unknowns: string[]     // facts we could not read, named honestly
}
```

`Choice<T>` carries `{ value, source: "preset" | "user" | "cluster-default", options: [{ value, label, hint?, disabled?, disabledReason? }] }`
— so a disabled option can always explain itself, which is most of the teaching in step 3.

Endpoints (all `dynamic = "force-dynamic"`, all fetched `{ cache: "no-store" }`):

| Route | Returns |
|---|---|
| `GET /api/provisioning/capabilities?ns=a,b` | offerings, storage classes, topology, per-namespace facts, policies, priority classes, `degraded[]` |
| `GET /api/provisioning/plan?<wizard params verbatim>` | `PlanResponse` |
| `GET /api/provisioning/instances?ns=a,b` | inventory + `degraded[]` |
| `GET /api/provisioning/instances/[namespace]/[resource]/[name]` | `{ status: "found" \| "absent"; instance?; object? }` — the `absent` case is what makes the track-before-apply page work |

The instance detail response carries `connect` and `readySignal` too, so the detail page needs
no second call.

## Sequencing

Each phase ships something usable, and the order is chosen so the **locally verifiable parts come
first** — minikube has no database operators and no working login, so the not-installed and
degraded paths are what a developer can actually see.

1. **Pure modules.** `types`, `constants`, `finding-style`, `purposes`, `manifest-lines`. No I/O,
   fully checkable by `tsc`.
2. **Facts + the reference page.** `facts/*` (including `gatherFacts`), the `accept` override on
   `kubeApiGet`, the RBAC ClusterRole, `GET /api/provisioning/capabilities`, and
   `app/provisioning/cluster-support/page.tsx`. Storage classes and nodes are real on minikube, so
   this is verifiable there. Immediately useful to the team on its own ("what does ee-lte-1
   actually offer?"), and it de-risks every later phase.
   **Settle the RBAC-aggregation question here** (see the discovery section) — the answer decides
   whether the whole feature can even hand a beginner a manifest they can apply.
3. **Catalog + `/provisioning` home.** Offering cards with availability, inventory section. On
   minikube every offering renders `Not installed`, so the state that must look intentional gets
   built and seen first.
4. **Wizard shell.** `use-wizard-params.ts`, `step-rail`, `step-offering`, `step-where`.
5. **Postgres end to end.** The cnpg recipe, the planner, findings, `step-size`/`step-options`/
   `step-review`, `constraint-rail`, and the annotated manifest. Prove the whole pipeline on the
   offering the team actually runs in production. **Add the test runner here**, with the planner as
   its first subject — this is the phase where untested trap logic starts costing real debugging.
6. **Apply step.** `step-apply`, the `command-row` extraction, `KubeconfigPanel` wiring, `then-what`.
7. **Detail page.** Including the `absent → found` polling transition that closes the loop.
8. **The rest of the catalog.** Dragonfly, Bucket, MongoDB, RabbitMQ, Redpanda, OpenSearch,
   Elastic, EMQX — one recipe at a time, no new machinery.
9. **MCP.** Transport, auth, the tool set, protected-resource metadata, the `driftmower-mcp`
   OIDCClient. Last, because it is a façade over work already proven through the UI — with the
   one caveat that the client-onboarding risk (below) should be probed early with a throwaway
   endpoint rather than discovered here.
10. **Nav + executive summary.** One `navItems` entry, one `SectionLinkCard`.

## Verification

There is **no test runner and no CI beyond a docker build**. Introduce the cheapest possible one,
and let it dictate the architecture:

```json
"test": "node --test --experimental-strip-types \"lib/features/provisioning/**/*.test.ts\""
```

Node 22 (the base image) strips types natively, so this adds **zero dependencies**. The
constraint it imposes is the point: Node's stripper does not resolve the `@/*` tsconfig alias, so
`catalog/*` and `plan/*` must use relative imports and must not import `@/lib/server/k8s` — which
enforces exactly the pure/impure split the design wants. `gatherFacts()` is the only impure
function; `buildPlan(input, facts)` is total over injected data. What to test:

1. **Golden manifests** — render every offering × preset, `loadAll()` each bundle with the
   dev-only `js-yaml` and deep-compare to the source objects, then assert `apiVersion`, `kind`,
   `metadata.name`, storage class and instance count. This is the highest-value test in the
   feature: it proves we emit parseable YAML for the thing users paste into `kubectl`.
2. **Finding matrix** — fixture `ClusterFacts` files (`no-cilium.json`, `tight-quota.json`,
   `single-zone.json`, `sandbox-with-cnpg-netpols.json`) × expected `Finding.code` sets. This is
   what regression-proofs the trap logic, whose bugs are invisible in the UI.
3. **Name validation** — YAML and shell injection attempts must produce `name.invalid`, never a
   rendered manifest.
4. **Version negotiation** — recipe wants `v2beta1`, cluster serves `v2alpha1` → blocker.

`vitest` + `vite-tsconfig-paths` would buy alias support and watch mode for two devDeps; skip it,
because the pure layer needs no aliases and the impure layer is not unit-testable anyway.

Baseline caveat before touching anything: `node_modules` is stale — `recharts` and `server-only`
are unmet, so `npx tsc --noEmit` currently fails with unrelated errors, plus one real
pre-existing error at `lib/features/actions/assess.ts:152` (missing `chartAppVersions`). Run
`npm install` first and record the baseline so new errors are distinguishable.

Gates: `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm test`.

Manual, end to end:
- **Locally** (`npm run dev`): only the not-in-cluster and unavailable states are reachable —
  OIDC cannot work on localhost (README), so anything session-gated is untestable here. `jose`
  verification *is* testable locally against a token pasted from a deployed session, since it
  needs only `OIDC_IDP_URI` and network. Verify the empty/degraded states look intentional.
- **minikube** (`skaffold run -p minikube`; that profile is currently uncommitted in
  `skaffold.yaml`, and `minikube-dev` is still an unrecovered TODO): passmower and
  prometheus-operator are installed, **no database operators are** — so this is the honest test
  of "no operators discovered" and of every unavailable-offering path, which are otherwise
  untestable on a real cluster. Then get a genuine inner loop for one offering with
  `helm install cnpg cloudnative-pg/cloudnative-pg` (~30s): real CRDs, real discovery output,
  and a real webhook to dry-run against.
- **ee-lte-1** (`skaffold run`): the only place the real matrix exists. Check per-offering
  availability against `values.ee-lte-1.yaml`; check a plan into a real sandbox namespace
  produces the quota, LimitRange and Cilium findings above; then take the emitted YAML and run
  `kubectl apply --server-side --dry-run=server` with a tenant kubeconfig. **If the apiserver
  accepts it, the manifest is correct by definition** — CRD schema, Kyverno, quota and every
  webhook all voted. That single command is a better oracle than any test we could write, and it
  costs nothing because it is already step 3 of the output. Any disagreement with the planner is
  a planner bug and the most valuable signal available.
- **RBAC**: `kubectl auth can-i --as=system:serviceaccount:driftmowers:driftmower-ui list storageclasses`
  for each new rule, and confirm the app degrades to `known: false` — not a 500 — when the
  ClusterRole has not rolled out yet.
- **MCP**: connect a client to `https://driftmower-ui.ee-lte-1.codemowers.io/api/mcp`, confirm the
  metadata document and the `WWW-Authenticate` header on a 401, then confirm `plan_provision` for a
  3×20Gi Postgres into a small sandbox comes back blocked with the storage-quota reason in prose.

## Risks

- **The login-route change is the one thing that can break existing users.** If passmower rejects
  a third `resource`, *login* fails for everyone. Hence `MCP_ENABLED=false` by default and a
  one-variable rollback; verify on a deployed build before flipping it.
- **MCP client onboarding** (no DCR in passmower) is the largest unknown. Probe it with a
  throwaway endpoint early rather than at the end of phase 9. If Claude.ai turns out to require
  DCR, the supported client list shrinks to Claude Code and Cursor, and phase 9 shrinks with it.
- **~1h token lifetime vs. static-header MCP clients.** Unavoidable: passmower issues no
  long-lived tokens and there is nowhere to keep a refresh token for a headless client.
  Paste-a-token is the demo path; OAuth is the real one.
- **Planner/admission divergence.** The lint approximates Kyverno and cannot run the admission
  chain. Mitigate by always emitting `--dry-run=server` first and never claiming certainty.
- **Recipe drift is the main long-term maintenance cost** — nine operators each moving their API
  version on their own schedule (`v2beta1` EMQX, `v1alpha2` Redpanda). Mitigated by version
  negotiation that blocks with a clear message rather than emitting a rejected manifest, and by
  `PROVISIONING_CATALOG_OVERRIDES` so one cluster can be patched without a release.
- **Two latent platform bugs this feature will surface, whose real fixes belong upstream.**
  `sandbox-stack` hard-codes `cnpg.io/cluster: database` in its network policies, so any other
  Postgres name in a sandbox silently never goes Ready — the durable fix is a shared-label or
  name-parameterised selector in that chart. And every ZFS StorageClass in `codemowers-kube`
  omits `volumeBindingMode`, i.e. `Immediate` binding on a node-local provisioner, which is a
  scheduling trap for every stateful workload on these clusters, not just databases. We detect and
  warn; both deserve issues in the sibling repos.
- **Scope creep toward applying.** The moment someone asks for a Create button, the whole
  authorization design changes (impersonation, or a platform-manager write path). Keep that
  decision explicit rather than letting it arrive as a small feature request.
