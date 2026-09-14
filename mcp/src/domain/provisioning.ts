// Wire types for driftmower-ui's provisioning capability layer.
//
// SOURCE OF TRUTH: driftmower-ui/lib/features/provisioning/types.ts. This is a
// hand-copied subset of the fields these tools read, not a generated artefact.
// The capability layer lives in driftmower-ui because that is where the
// Kubernetes reads and the RBAC for them live (driftmower-ui/k8s/rbac.yaml);
// this server is a façade over its HTTP API.
//
// Keeping a copy rather than sharing a package is a deliberate, temporary
// trade: see driftmower-ui/provisioning.md. When the planner tools land and the
// shared surface grows, extract a package instead of widening this file.

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

export type Purpose =
  'relational' | 'cache' | 'document' | 'queue' | 'stream' | 'search' | 'mqtt' | 'object-store'

export type PresetId = 'dev' | 'small' | 'ha'

// A fact that could not be read degrades rather than silently passing:
// "absent" means the API does not serve it, "rbac" means we were refused. Both
// must reach the caller as prose, never as a quiet success.
export interface DegradedRead {
  source: string
  status: number
  message: string
}

export type Availability =
  | { state: 'ready'; version: string | null; watchedNamespaces: string[] | 'all' }
  | { state: 'degraded'; version: string | null; reason: string }
  | { state: 'crds-only'; reason: string }
  | { state: 'not-installed'; installHref: string | null }

export interface OfferingCard {
  id: OfferingId
  name: string
  purpose: Purpose
  what: string
  goodFor: string[]
  operator: { name: string; vendor: string; docsHref: string } | null
  resource: string | null
  apiVersion: string | null
  availability: Availability
  presets: { id: PresetId; label: string; summary: string }[]
  needs: string[]
  instanceCount: number
}

// How a volume behaves, which is the difference between "3 replicas" meaning
// resilience and meaning three copies pinned to three machines.
export type StorageTopology = 'node-local' | 'zonal' | 'cluster-wide' | 'unknown'

export interface StorageClassFact {
  name: string
  provisioner: string
  isDefault: boolean
  bindingMode: 'Immediate' | 'WaitForFirstConsumer'
  allowExpansion: boolean
  reclaimPolicy: 'Delete' | 'Retain' | 'Recycle'
  topology: StorageTopology
  implies: string
  replicaSafe: boolean
}

export type QuotaAmounts = Partial<Record<string, string>>

export type NetworkPosture = 'default-deny' | 'open' | 'unknown'

export interface PolicySelector {
  policy: string
  kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
  direction: 'Ingress' | 'Egress'
  labelKey: string
  // null when the selector is `Exists`, i.e. it matches every instance name.
  labelValue: string | null
  admits: string
}

export interface NamespaceFact {
  namespace: string
  sandbox: string | null
  quota: { name: string; used: QuotaAmounts; hard: QuotaAmounts } | null
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
    selectors: PolicySelector[]
    ciliumAvailable: boolean
  }
  // Approximate by construction (aggregated roles, wildcards), so it must never
  // be presented as a hard verdict.
  mayCreate: 'likely' | 'likely-not' | 'unknown'
  mayCreateReason: string
  podSecurity: {
    enforce: 'privileged' | 'baseline' | 'restricted'
    requires: string[]
    summary: string
  } | null
}

export interface ZoneFact {
  zone: string
  nodes: number
  allocatable: { cpuMillis: number; memoryBytes: number }
}

export interface TopologyFact {
  zones: ZoneFact[]
  schedulableNodes: number
  controlPlaneLabel: { key: string; value: string } | null
}

export interface PolicyFact {
  engine: 'kyverno'
  name: string
  mode: 'Enforce' | 'Audit'
  touches: string[]
  meaning: string
}

export interface HostRule {
  namespace: string
  sandboxId: string | null
  exactHost: string | null
  labelledPattern: string | null
  enforcedBy: string | null
  enforcedMessage: string | null
  note: string
}

export interface IngressFact {
  domainSuffix: string | null
  // "guard-params" is what admission compares against; "app-base-url" is
  // derived from driftmower-ui's own hostname and could differ from the guard.
  domainSuffixSource: 'guard-params' | 'app-base-url' | null
  classes: { name: string; controller: string; isDefault: boolean }[]
  clusterIssuers: string[]
  sharedWildcard: boolean
  tlsAdvice: string
  hostRules: HostRule[]
}

// A ValidatingAdmissionPolicy. These override RBAC, which is why a permission
// verdict that consults only RoleBindings answers optimistically.
export interface AdmissionFact {
  name: string
  enforced: boolean
  enforcement: string
  guards: { group: string; resource: string; operations: string[] }[]
  messages: string[]
  scopedToNamespaceLabels: Record<string, string> | null
}

export interface CapabilityResponse {
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
