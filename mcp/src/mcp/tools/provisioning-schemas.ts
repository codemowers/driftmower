import { z } from 'zod'

// Output schemas for the provisioning tools.
//
// Upstream-derived structures use `looseObject`: these mirror
// driftmower-ui/lib/features/provisioning/types.ts, which evolves on its own
// schedule, and a strict schema here would turn "driftmower-ui added a field"
// into "every tool call fails validation". The envelope this server owns —
// status, reason, counts — is enumerated strictly, because that is what an
// agent branches on.

export const UNAVAILABLE_REASONS = ['unauthorized', 'unreachable', 'bad_response', 'not_in_cluster'] as const

const degradedSchema = z.looseObject({
  source: z.string(),
  status: z.number(),
  message: z.string()
})

const storageClassSchema = z.looseObject({
  name: z.string(),
  provisioner: z.string(),
  isDefault: z.boolean(),
  bindingMode: z.string(),
  allowExpansion: z.boolean(),
  reclaimPolicy: z.string(),
  topology: z.string(),
  implies: z.string(),
  replicaSafe: z.boolean()
})

const offeringSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  what: z.string(),
  availability: z.looseObject({ state: z.string() }),
  instanceCount: z.number()
})

const namespaceFactSchema = z.looseObject({
  namespace: z.string(),
  sandbox: z.string().nullable(),
  mayCreate: z.enum(['likely', 'likely-not', 'unknown']),
  mayCreateReason: z.string()
})

const hostRuleSchema = z.looseObject({
  namespace: z.string(),
  sandboxId: z.string().nullable(),
  exactHost: z.string().nullable(),
  note: z.string()
})

// Every tool can answer "I could not find out". Keeping the failure in the
// output schema rather than raising an MCP error means the caller gets a
// reason it can act on instead of a transport-level failure.
const unavailableFields = {
  reason: z.enum(UNAVAILABLE_REASONS).optional(),
  detail: z.string().optional()
}

export const describeClusterCapabilitiesOutputShape = {
  status: z.enum(['ok', 'unavailable']),
  ...unavailableFields,
  storageClasses: z.array(storageClassSchema).optional(),
  topology: z.looseObject({ schedulableNodes: z.number() }).optional(),
  priorityClasses: z.array(z.looseObject({ name: z.string(), value: z.number() })).optional(),
  networkPolicyEngine: z.string().optional(),
  monitoringOperator: z.boolean().optional(),
  ingress: z.looseObject({ domainSuffix: z.string().nullable() }).optional(),
  policies: z.array(z.looseObject({ name: z.string() })).optional(),
  admissionPolicies: z.array(z.looseObject({ name: z.string(), enforced: z.boolean() })).optional(),
  offeringsReady: z.number().optional(),
  offeringsTotal: z.number().optional(),
  degraded: z.array(degradedSchema).optional()
}

export const listOfferingsOutputShape = {
  status: z.enum(['ok', 'unavailable']),
  ...unavailableFields,
  offerings: z.array(offeringSchema).optional(),
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
