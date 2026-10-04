import { z } from 'zod'
import { VERBS } from '../../domain/provisioning/access-facts.js'

// Output schemas for the provisioning tools. The shapes are owned here now,
// so they are strict: an agent branches on them.

export const UNAVAILABLE_REASONS = ['kubernetes_unreachable'] as const

export const verdictSchema = z.enum(['yes', 'no', 'unknown'])

const degradedSchema = z.object({ source: z.string(), status: z.number(), message: z.string() })

const storageClassSchema = z.object({
  name: z.string(),
  provisioner: z.string(),
  isDefault: z.boolean(),
  bindingMode: z.enum(['Immediate', 'WaitForFirstConsumer']),
  allowExpansion: z.boolean(),
  reclaimPolicy: z.enum(['Delete', 'Retain', 'Recycle']),
  topology: z.enum(['node-local', 'zonal', 'cluster-wide', 'unknown']),
  implies: z.string(),
  replicaSafe: z.boolean()
})

const availabilitySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    version: z.string().nullable(),
    watchedNamespaces: z.union([z.array(z.string()), z.literal('all')])
  }),
  z.object({ state: z.literal('degraded'), version: z.string().nullable(), reason: z.string() }),
  z.object({ state: z.literal('crds-only'), reason: z.string() }),
  z.object({ state: z.literal('not-installed'), installHref: z.string().nullable() })
])

const admissionDefaultSchema = z.object({
  policy: z.string(),
  resource: z.string(),
  description: z.string().nullable(),
  namespaceScoped: z.boolean()
})

export const offeringSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  what: z.string(),
  goodFor: z.array(z.string()),
  operator: z.object({ name: z.string(), vendor: z.string(), docsHref: z.string() }).nullable(),
  resource: z.string().nullable(),
  apiVersion: z.string().nullable(),
  availability: availabilitySchema,
  presets: z.array(z.object({ id: z.string(), label: z.string(), summary: z.string() })),
  needs: z.array(z.string()),
  admissionDefaults: z.array(admissionDefaultSchema),
  mayCreate: verdictSchema.optional(),
  mayCreateReason: z.string().optional()
})

const amounts = z.record(z.string(), z.string())
const verbRecord = z.object(
  Object.fromEntries(VERBS.map(verb => [verb, verdictSchema])) as Record<
    (typeof VERBS)[number],
    typeof verdictSchema
  >
)
const verbCounts = z.object(
  Object.fromEntries(VERBS.map(verb => [verb, z.number()])) as Record<(typeof VERBS)[number], z.ZodNumber>
)

export const accessProfileSchema = z.object({
  matrix: z.record(z.string(), verbRecord),
  view: verdictSchema,
  edit: verdictSchema,
  admin: verdictSchema,
  provision: z.record(z.string(), verdictSchema),
  provisionDetail: z.record(
    z.string(),
    z.array(z.object({ resource: z.string(), verdict: verdictSchema, reason: z.string().nullable() }))
  ),
  summary: z.object({ resourceTypes: z.number(), byVerb: verbCounts, unknown: z.number() })
})

export const namespaceFactSchema = z.object({
  namespace: z.string(),
  tenant: z.object({ labelKey: z.string(), id: z.string() }).nullable(),
  sandbox: z.string().nullable(),
  quota: z.object({ name: z.string(), used: amounts, hard: amounts }).nullable(),
  headroom: z
    .object({
      cpuMillis: z.number().nullable(),
      memoryBytes: z.number().nullable(),
      storageBytes: z.number().nullable(),
      pvcCount: z.number().nullable(),
      pods: z.number().nullable()
    })
    .nullable(),
  limitRange: z.object({ defaultRequest: amounts, default: amounts }).nullable(),
  network: z.object({
    ingress: z.enum(['default-deny', 'open', 'unknown']),
    egress: z.enum(['default-deny', 'open', 'unknown']),
    selectors: z.array(
      z.object({
        policy: z.string(),
        kind: z.enum(['NetworkPolicy', 'CiliumNetworkPolicy']),
        direction: z.enum(['Ingress', 'Egress']),
        labelKey: z.string(),
        labelValue: z.string().nullable(),
        admits: z.string()
      })
    ),
    ciliumAvailable: z.boolean()
  }),
  access: accessProfileSchema.nullable(),
  mayCreate: verdictSchema,
  mayCreateReason: z.string(),
  offerings: z.record(z.string(), z.object({ verdict: verdictSchema, reason: z.string() })),
  registries: z.array(
    z.object({
      kind: z.literal('zot'),
      host: z.string(),
      tls: z.boolean(),
      deployment: z.string(),
      service: z.string(),
      ingress: z.string(),
      skaffoldEnv: z.string()
    })
  ),
  podSecurity: z
    .object({
      enforce: z.enum(['privileged', 'baseline', 'restricted']),
      requires: z.array(z.string()),
      summary: z.string()
    })
    .nullable()
})

export const hostRuleSchema = z.object({
  namespace: z.string(),
  tenantId: z.string().nullable(),
  sandboxId: z.string().nullable(),
  exactHost: z.string().nullable(),
  labelledPattern: z.string().nullable(),
  enforcedBy: z.string().nullable(),
  enforcedMessage: z.string().nullable(),
  customDomains: z.array(z.string()),
  note: z.string()
})

const admissionFactSchema = z.object({
  name: z.string(),
  enforced: z.boolean(),
  enforcement: z.string(),
  guards: z.array(z.object({ group: z.string(), resource: z.string(), operations: z.array(z.string()) })),
  messages: z.array(z.string()),
  scopedToNamespaceLabels: z.record(z.string(), z.string()).nullable()
})

const ingressSchema = z.object({
  domainSuffix: z.string().nullable(),
  domainSuffixSource: z.enum(['guard-params', 'config']).nullable(),
  classes: z.array(z.object({ name: z.string(), controller: z.string(), isDefault: z.boolean() })),
  clusterIssuers: z.array(z.string()),
  tlsAdvice: z.string()
})

// Every tool can answer "I could not find out". Keeping the failure in the
// output schema rather than raising an MCP error means the caller gets a
// reason it can act on instead of a transport-level failure.
const unavailableFields = {
  reason: z.enum(UNAVAILABLE_REASONS).optional(),
  detail: z.string().optional()
}

export const describeProvisioningPlatformOutputShape = {
  status: z.enum(['ok', 'unavailable']),
  ...unavailableFields,
  storageClasses: z.array(storageClassSchema).optional(),
  topology: z
    .object({
      zones: z.array(
        z.object({
          zone: z.string(),
          nodes: z.number(),
          allocatable: z.object({ cpuMillis: z.number(), memoryBytes: z.number() })
        })
      ),
      schedulableNodes: z.number(),
      controlPlaneLabel: z.object({ key: z.string(), value: z.string() }).nullable()
    })
    .optional(),
  priorityClasses: z
    .array(z.object({ name: z.string(), value: z.number(), isDefault: z.boolean(), meaning: z.string() }))
    .optional(),
  networkPolicyEngine: z.enum(['cilium', 'native', 'none', 'unknown']).optional(),
  monitoringOperator: z.boolean().optional(),
  ingress: ingressSchema.optional(),
  policies: z
    .array(
      z.object({
        engine: z.literal('kyverno'),
        name: z.string(),
        mode: z.enum(['Enforce', 'Audit']),
        touches: z.array(z.string()),
        meaning: z.string()
      })
    )
    .optional(),
  admissionPolicies: z.array(admissionFactSchema).optional(),
  tenantLabelKey: z.string().nullable().optional(),
  offeringsReady: z.number().optional(),
  offeringsTotal: z.number().optional(),
  degraded: z.array(degradedSchema).optional()
}

export const listOfferingsOutputShape = {
  status: z.enum(['ok', 'unavailable']),
  ...unavailableFields,
  offerings: z.array(offeringSchema).optional(),
  withheld: z.array(z.string()).optional(),
  degraded: z.array(degradedSchema).optional()
}

export const describeNamespaceReadinessOutputShape = {
  status: z.enum(['ok', 'unavailable']),
  ...unavailableFields,
  requested: z.array(z.string()).optional(),
  namespaces: z.array(namespaceFactSchema).optional(),
  hostRules: z.array(hostRuleSchema).optional(),
  // Requested but not returned. Distinct from an empty result: it means the
  // namespace was withheld, not that it is empty.
  withheld: z.array(z.string()).optional(),
  degraded: z.array(degradedSchema).optional()
}

export const checkAccessOutputShape = {
  status: z.enum(['ok', 'unavailable']),
  ...unavailableFields,
  verdict: verdictSchema.optional(),
  reason: z.string().optional(),
  rbac: z.object({ verdict: verdictSchema, reason: z.string().nullable() }).optional(),
  admission: z.array(z.object({ policy: z.string(), messages: z.array(z.string()) })).optional(),
  admissionDefaults: z.array(admissionDefaultSchema).optional(),
  identity: z
    .object({ user: z.string(), groups: z.array(z.string()) })
    .nullable()
    .optional()
}
