// Wire types for the provisioning capability layer: what the JSON route
// returns and what the MCP tools reshape. Kept free of Kubernetes client
// imports so the pure fact modules can be unit-tested with no cluster at all.

import type { Verb, Verdict } from './access-facts.js'

export type OfferingId =
  | 'postgres'
  | 'dragonfly'
  | 'mongodb'
  | 'rabbitmq'
  | 'redpanda'
  | 'opensearch'
  | 'elasticsearch'
  | 'emqx'
  | 'bucket'

// What the thing is *for*, in the user's words rather than the operator's.
export type Purpose =
  'relational' | 'cache' | 'document' | 'queue' | 'stream' | 'search' | 'mqtt' | 'object-store'

export type PresetId = 'dev' | 'small' | 'ha'

// A fact we could not read degrades to `known: false` rather than silently
// passing: "absent" means the API does not serve it, "rbac" means we were
// refused. Both must reach the user as prose.
export type Unknown = { known: false; reason: 'rbac' | 'absent'; detail: string }
export type Known<T> = { known: true; value: T }
export type Fact<T> = Known<T> | Unknown

export type DegradedRead = {
  // The fact family, e.g. "storageclasses". A stable key for consumers.
  source: string
  status: number
  message: string
}

export type Availability =
  | { state: 'ready'; version: string | null; watchedNamespaces: string[] | 'all' }
  | { state: 'degraded'; version: string | null; reason: string }
  | { state: 'crds-only'; reason: string }
  | { state: 'not-installed'; installHref: string | null }

export type OfferingCard = {
  id: OfferingId
  name: string
  purpose: Purpose
  // One plain-words sentence; never mentions the operator.
  what: string
  goodFor: string[]
  operator: { name: string; vendor: string; docsHref: string } | null
  // "clusters.postgresql.cnpg.io": the resource a user would kubectl get.
  resource: string | null
  // The version actually negotiated against this cluster, not the recipe's preference.
  apiVersion: string | null
  availability: Availability
  presets: { id: PresetId; label: string; summary: string }[]
  // What the offering would need before it could be installed here.
  needs: string[]
  // Present only when a namespace was asked about: may the caller create this
  // offering there, from the access matrix and admission policies.
  mayCreate?: Verdict
  mayCreateReason?: string
}

// How a volume behaves, which is the difference between "3 replicas" meaning
// resilience and meaning three copies pinned to three machines.
export type StorageTopology = 'node-local' | 'zonal' | 'cluster-wide' | 'unknown'

export type StorageClassFact = {
  name: string
  provisioner: string
  isDefault: boolean
  bindingMode: 'Immediate' | 'WaitForFirstConsumer'
  allowExpansion: boolean
  reclaimPolicy: 'Delete' | 'Retain' | 'Recycle'
  topology: StorageTopology
  // Exactly one beginner-facing clause.
  implies: string
  // Can two instances live here and still be moved by their operator?
  replicaSafe: boolean
}

export type QuotaAmounts = Partial<Record<string, string>>

export type NetworkPosture = 'default-deny' | 'open' | 'unknown'

export type AccessProfile = {
  // "group/resource" (core group is "") -> verdict per verb.
  matrix: Record<string, Record<Verb, Verdict>>
  view: Verdict
  edit: Verdict
  admin: Verdict
  provision: Partial<Record<OfferingId, Verdict>>
  provisionDetail: Partial<
    Record<OfferingId, { resource: string; verdict: Verdict; reason: string | null }[]>
  >
  summary: { resourceTypes: number; byVerb: Record<Verb, number>; unknown: number }
}

export type NamespaceFact = {
  namespace: string
  // The namespace label an enforced admission guard scopes on, and its value
  // here. Discovered from the cluster's own policies, never configured.
  tenant: { labelKey: string; id: string } | null
  // Kept for one release for consumers that still read it; equals tenant.id.
  sandbox: string | null
  quota: { name: string; used: QuotaAmounts; hard: QuotaAmounts } | null
  // Pre-computed so consumers never re-parse Kubernetes quantity strings.
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
    // shape preserved: exact-name matchLabels versus name-agnostic matchExpressions.
    selectors: PolicySelector[]
    ciliumAvailable: boolean
  }
  // Exact, from the cluster authorizer: one SubjectAccessReview per resource
  // and verb, as the verified caller. Null when the call was unauthenticated.
  access: AccessProfile | null
  // For the offering that was asked about; admission denials first, then RBAC.
  mayCreate: Verdict
  mayCreateReason: string
  // The same verdict for every offering the catalog knows, so a caller that
  // shows them all need not ask once per offering. Enforced admission policies
  // are applied here, unlike access.provision, which is RBAC alone.
  offerings: Partial<Record<OfferingId, { verdict: Verdict; reason: string }>>
  // Pod Security Admission is a built-in controller, so it appears in no
  // ValidatingAdmissionPolicy or Kyverno listing.
  podSecurity: {
    enforce: 'privileged' | 'baseline' | 'restricted'
    requires: string[]
    summary: string
  } | null
}

export type PolicySelector = {
  policy: string
  kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
  direction: 'Ingress' | 'Egress'
  labelKey: string
  // null when the selector is `Exists`, i.e. it matches every instance name.
  labelValue: string | null
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
  // Derived from node labels rather than configured per cluster.
  controlPlaneLabel: { key: string; value: string } | null
}

export type PolicyFact = {
  engine: 'kyverno'
  name: string
  // Enforce policies can reject an apply; Audit ones only report.
  mode: 'Enforce' | 'Audit'
  touches: string[]
  meaning: string
}

export type HostRule = {
  namespace: string
  tenantId: string | null
  // Kept for one release; equals tenantId.
  sandboxId: string | null
  exactHost: string | null
  labelledPattern: string | null
  enforcedBy: string | null
  // The guard's own denial text, so the consequence of getting it wrong is
  // visible before the apiserver says it.
  enforcedMessage: string | null
  // Custom domains the guard also accepts here, with every name under them.
  customDomains: string[]
  note: string
}

// Where an app is reachable from, and what hostname the cluster will accept.
export type IngressFact = {
  domainSuffix: string | null
  // "guard-params" is what admission compares against; "config" was set by the
  // operator of this server and is not verified against any policy.
  domainSuffixSource: 'guard-params' | 'config' | null
  classes: { name: string; controller: string; isDefault: boolean }[]
  clusterIssuers: string[]
  tlsAdvice: string
  hostRules: HostRule[]
}

// A ValidatingAdmissionPolicy. These override RBAC, which is why the create
// verdict consults them before it trusts the authorizer's answer.
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
  networkPolicyEngine: 'cilium' | 'native' | 'none' | 'unknown'
  monitoringOperator: boolean
  degraded: DegradedRead[]
}
