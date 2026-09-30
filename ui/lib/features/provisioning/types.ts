// Wire types for the provisioning page. CapabilityResponse and the facts in it
// are what driftmower-mcp's GET /api/provisioning/capabilities returns
// (driftmower-mcp/src/domain/provisioning/types.ts); this app relays it. Kept
// free of server imports so the pure catalog layer can use them in unit tests.

export type OfferingId =
  | "postgres"
  | "dragonfly"
  | "mongodb"
  | "rabbitmq"
  | "redpanda"
  | "opensearch"
  | "elasticsearch"
  | "emqx"
  | "bucket"

// What the thing is *for*, in the user's words rather than the operator's.
export type Purpose =
  | "relational"
  | "cache"
  | "document"
  | "queue"
  | "stream"
  | "search"
  | "mqtt"
  | "object-store"

export type PresetId = "dev" | "small" | "ha"

// A fact we could not read degrades to `known: false` rather than silently
// passing: "absent" means the API does not serve it, "rbac" means we were
// refused. Both must reach the user as prose.
export type Unknown = { known: false; reason: "rbac" | "absent"; detail: string }
export type Known<T> = { known: true; value: T }
export type Fact<T> = Known<T> | Unknown

export type DegradedRead = {
  // The fact family, e.g. "storageclasses". Used as a stable key in the UI.
  source: string
  status: number
  // Actionable prose, shaped like nodeLoadError() in lib/cluster-resources/nodes.ts.
  message: string
}

export type Availability =
  | { state: "ready"; version: string | null; watchedNamespaces: string[] | "all" }
  | { state: "degraded"; version: string | null; reason: string }
  | { state: "crds-only"; reason: string }
  | { state: "not-installed"; installHref: string | null }

export type OfferingCard = {
  id: OfferingId
  name: string
  purpose: Purpose
  // One plain-words sentence; never mentions the operator.
  what: string
  goodFor: string[]
  operator: { name: string; vendor: string; docsHref: string } | null
  // "clusters.postgresql.cnpg.io" — the resource a user would kubectl get.
  resource: string | null
  // The version actually negotiated against this cluster, not the recipe's preference.
  apiVersion: string | null
  availability: Availability
  presets: { id: PresetId; label: string; summary: string }[]
  // What the offering would need before it could be installed here. Rendered for
  // not-installed offerings so the card is never a dead end.
  needs: string[]
  // Present only when a namespace was asked about: may the caller create this
  // offering there, from the access matrix and admission policies.
  mayCreate?: Verdict
  mayCreateReason?: string
}

// The cluster authorizer's own answer, never inferred from role names.
// "unknown" is a real outcome (the review could not be evaluated), not "no".
export type Verdict = "yes" | "no" | "unknown"

export type Verb = "get" | "list" | "watch" | "create" | "update" | "patch" | "delete" | "deletecollection"

export type AccessProfile = {
  // "group/resource" (core group is "", so pods are "/pods") -> verdict per verb.
  // Absent when requested with access=summary, which this page does.
  matrix?: Record<string, Record<Verb, Verdict>>
  view: Verdict
  edit: Verdict
  admin: Verdict
  provision: Partial<Record<OfferingId, Verdict>>
  provisionDetail: Partial<Record<OfferingId, { resource: string; verdict: Verdict; reason: string | null }[]>>
  summary: { resourceTypes: number; byVerb: Record<Verb, number>; unknown: number }
}

// How a volume behaves, which is the difference between "3 replicas" meaning
// resilience and meaning three copies pinned to three machines.
export type StorageTopology = "node-local" | "zonal" | "cluster-wide" | "unknown"

export type StorageClassFact = {
  name: string
  provisioner: string
  isDefault: boolean
  bindingMode: "Immediate" | "WaitForFirstConsumer"
  allowExpansion: boolean
  reclaimPolicy: "Delete" | "Retain" | "Recycle"
  topology: StorageTopology
  // Exactly one beginner-facing clause. The reference page shows the raw fields.
  implies: string
  // Can two instances live here and still be moved by their operator?
  replicaSafe: boolean
}

export type QuotaAmounts = Partial<Record<string, string>>

export type NetworkPosture = "default-deny" | "open" | "unknown"

export type NamespaceFact = {
  namespace: string
  // The namespace label an enforced admission guard scopes tenancy on, and its
  // value here; discovered by driftmower-mcp from the cluster's policies.
  tenant: { labelKey: string; id: string } | null
  // Equals tenant.id; kept by driftmower-mcp for one release.
  sandbox: string | null
  quota: { name: string; used: QuotaAmounts; hard: QuotaAmounts } | null
  // Pre-computed so the planner never re-parses Kubernetes quantity strings.
  headroom: {
    cpuMillis: number | null
    memoryBytes: number | null
    storageBytes: number | null
    pvcCount: number | null
    pods: number | null
  } | null
  limitRange: { defaultRequest: QuotaAmounts; default: QuotaAmounts } | null
  network: {
    ingress: NetworkPosture
    egress: NetworkPosture
    // Every policy that selects on an offering's own label, with the selector
    // shape preserved: the sandbox bundle mixes exact-name matchLabels with
    // name-agnostic matchExpressions, and only the latter covers any instance.
    selectors: PolicySelector[]
    ciliumAvailable: boolean
  }
  // Exact, from SubjectAccessReviews asked as the user. Null when unauthenticated.
  access: AccessProfile | null
  // For the offering asked about; enforced admission policies first, then RBAC.
  mayCreate: Verdict
  mayCreateReason: string
  // The same composed verdict for every offering in the catalog: RBAC across
  // everything its sample creates, then enforced admission policies. This, not
  // access.provision (RBAC alone), is what to show a user.
  offerings: Partial<Record<OfferingId, { verdict: Verdict; reason: string }>>
  // Pod Security Admission is a built-in controller, so it appears in no
  // ValidatingAdmissionPolicy or Kyverno listing — and on these clusters it is
  // the constraint most likely to stop a first pod.
  podSecurity: {
    enforce: "privileged" | "baseline" | "restricted"
    requires: string[]
    summary: string
  } | null
}

export type PolicySelector = {
  policy: string
  kind: "NetworkPolicy" | "CiliumNetworkPolicy"
  direction: "Ingress" | "Egress"
  labelKey: string
  // null when the selector is `Exists`, i.e. it matches every instance name.
  labelValue: string | null
  // What the policy actually admits, for the finding's `detail`.
  admits: string
}

export type ZoneFact = {
  zone: string
  nodes: number
  allocatable: { cpuMillis: number; memoryBytes: number }
}

export type TopologyFact = {
  zones: ZoneFact[]
  schedulableNodes: number
  // Derived from node labels rather than configured per cluster: k3s uses
  // node-role.kubernetes.io/control-plane, the AWS clusters codemowers.cloud/node-role.
  controlPlaneLabel: { key: string; value: string } | null
}

export type PolicyFact = {
  engine: "kyverno"
  name: string
  // Enforce policies can reject an apply; Audit ones only report.
  mode: "Enforce" | "Audit"
  touches: string[]
  meaning: string
}

// Where an app is reachable from, and what hostname the cluster will accept.
// Users cannot guess this: a sandbox id begins with a random hash, and the rule
// is enforced by admission rather than convention.
export type IngressFact = {
  domainSuffix: string | null
  // "guard-params" is what admission compares against; "config" was set on
  // driftmower-mcp and is not verified against any policy.
  domainSuffixSource: "guard-params" | "config" | null
  classes: { name: string; controller: string; isDefault: boolean }[]
  clusterIssuers: string[]
  tlsAdvice: string
  // Per requested namespace, the two hostnames its sandbox may claim.
  hostRules: {
    namespace: string
    tenantId: string | null
    // Equals tenantId; kept by driftmower-mcp for one release.
    sandboxId: string | null
    exactHost: string | null
    labelledPattern: string | null
    enforcedBy: string | null
    // The guard's own denial text, so the consequence of getting it wrong is
    // visible before the apiserver says it.
    enforcedMessage: string | null
    note: string
  }[]
}

// A ValidatingAdmissionPolicy. These override RBAC, which is why the permission
// verdict consults them before it trusts a RoleBinding.
export type AdmissionFact = {
  name: string
  enforced: boolean
  enforcement: string
  guards: { group: string; resource: string; operations: string[] }[]
  messages: string[]
  scopedToNamespaceLabels: Record<string, string> | null
}

export type CapabilityResponse = {
  inCluster: boolean
  offerings: OfferingCard[]
  storageClasses: StorageClassFact[]
  topology: TopologyFact
  namespaces: NamespaceFact[]
  policies: PolicyFact[]
  admissionPolicies: AdmissionFact[]
  ingress: IngressFact
  priorityClasses: { name: string; value: number; isDefault: boolean; meaning: string }[]
  networkPolicyEngine: "cilium" | "native" | "none" | "unknown"
  monitoringOperator: boolean
  degraded: DegradedRead[]
  // Requested namespaces the user may not list pods in (or whose review could
  // not be evaluated). Their facts are withheld, not absent.
  withheld: string[]
}

export type FindingSeverity = "blocker" | "warning" | "note"

export type WizardStep = "offering" | "where" | "size" | "options" | "review" | "apply"

export type Finding = {
  // Stable machine string, e.g. "quota.requests-memory". The UI anchors on it,
  // an agent branches on it, and tests assert on it without matching prose.
  code: string
  severity: FindingSeverity
  // Which step owns the fix, so the wizard can put it where the choice is made.
  step: Exclude<WizardStep, "review" | "apply">
  // The consequence, not the rule. <= 70 chars.
  title: string
  // The mechanism, naming real objects so the sentence is greppable.
  detail: string
  // One transferable sentence: why this bites, in general.
  why: string
  // Pure URL-param patches, so a fix is never a dead end.
  fixes: { label: string; patch: Record<string, string | null> }[]
  learnMore?: { label: string; href: string }
  // Set when an unreadable fact forced a blocker down to a warning.
  degradedFrom?: "blocker"
}

export type ChoiceOption<T> = {
  value: T
  label: string
  hint?: string
  disabled?: boolean
  // A disabled option must always explain itself; that is most of the teaching
  // in the sizing step.
  disabledReason?: string
}

export type Choice<T> = {
  value: T
  source: "preset" | "user" | "cluster-default"
  options: ChoiceOption<T>[]
}

export type PlanObject = {
  index: number
  kind: string
  apiVersion: string
  name: string
  namespace: string
  role: "primary" | "secret" | "policy" | "monitor" | "backup" | "config" | "rbac"
  does: string
  why: string
  optional: boolean
  // The wizard param that toggles this object, when optional.
  includedBy?: string
  object: Record<string, unknown>
  // jsonPath -> inline note, rendered by DocumentViewer beside the line.
  notes: Record<string, string>
}

export type ConnectionInfo = {
  serviceName: string
  port: number
  secretName: string
  // A command, never a value: the app must not read Secret contents.
  passwordCommand: string
  dsnHint: string
}

export type PlanCommand = { label: string; value: string; why: string; hint?: string }

export type PlanResponse = {
  // False when any blocker is present.
  ok: boolean
  // Operator missing: manifests are shown read-only, nothing is validated.
  preview: boolean
  resolved: {
    instances: number
    storageGi: number
    storageClass: string | null
    version: string | null
  }
  choices: {
    instances: Choice<number>
    storageClass: Choice<string>
    storageGi: Choice<number>
    version: Choice<string>
  }
  findings: Finding[]
  objects: PlanObject[]
  commands: PlanCommand[]
  readySignal: { humanText: string; watchCommand: string }
  connect: ConnectionInfo | null
  trackHref: string
  filename: string
  // Facts we could not read, named honestly.
  unknowns: string[]
}

export type InstanceSummary = {
  offering: OfferingId | null
  kind: string
  // "clusters.postgresql.cnpg.io", so the detail URL is kubectl-derivable.
  resource: string
  name: string
  namespace: string
  ready: boolean | null
  instances: number | null
  storageClass: string | null
  storageGi: number | null
  backupConfigured: boolean
  href: string
}

export type InstancesResponse = {
  instances: InstanceSummary[]
  degraded: DegradedRead[]
}

export type InstanceDetailResponse =
  | { status: "absent"; namespace: string; resource: string; name: string; hint: string }
  | {
      status: "found"
      instance: InstanceSummary
      connect: ConnectionInfo | null
      readySignal: { humanText: string; watchCommand: string }
      object: Record<string, unknown>
    }
