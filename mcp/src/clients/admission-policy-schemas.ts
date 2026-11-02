import { z } from 'zod'

const selector = z.object({
  matchLabels: z.record(z.string(), z.string()).optional(),
  matchExpressions: z
    .array(
      z.object({
        key: z.string(),
        operator: z.string(),
        values: z.array(z.string()).optional()
      })
    )
    .optional()
})
const rule = z.object({
  apiGroups: z.array(z.string()).optional(),
  apiVersions: z.array(z.string()).optional(),
  operations: z.array(z.string()).optional(),
  resources: z.array(z.string()).optional(),
  resourceNames: z.array(z.string()).optional(),
  scope: z.string().optional()
})
const matching = z.object({
  matchPolicy: z.string().optional(),
  namespaceSelector: selector.optional(),
  objectSelector: selector.optional(),
  resourceRules: z.array(rule).optional(),
  excludeResourceRules: z.array(rule).optional()
})
const namedExpression = z.object({ name: z.string(), expression: z.string() })

// Preserve the API's values and expressions. This is inspection, not CEL
// evaluation or a prediction of effective admission behavior for a workload.
export const admissionSpecSchema = z
  .object({
    failurePolicy: z.string().optional(),
    reinvocationPolicy: z.string().optional(),
    matchConstraints: matching.optional(),
    matchConditions: z.array(namedExpression).optional(),
    variables: z.array(namedExpression).optional(),
    paramKind: z.object({ apiVersion: z.string(), kind: z.string() }).optional(),
    validations: z
      .array(
        z.object({
          expression: z.string(),
          message: z.string().optional(),
          messageExpression: z.string().optional(),
          reason: z.string().optional()
        })
      )
      .optional(),
    mutations: z
      .array(
        z.object({
          patchType: z.string(),
          jsonPatch: z.object({ expression: z.string() }).optional(),
          applyConfiguration: z.object({ expression: z.string() }).optional()
        })
      )
      .optional(),
    auditAnnotations: z.array(z.object({ key: z.string(), valueExpression: z.string() })).optional()
  })
  .passthrough()

export const admissionBindingSpecSchema = z
  .object({
    policyName: z.string(),
    validationActions: z.array(z.string()).optional(),
    matchResources: matching.optional(),
    paramRef: z
      .object({
        name: z.string().optional(),
        namespace: z.string().optional(),
        selector: selector.optional(),
        parameterNotFoundAction: z.string().optional()
      })
      .optional()
  })
  .passthrough()
