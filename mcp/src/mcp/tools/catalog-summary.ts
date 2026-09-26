import { z } from 'zod'
import { admissionSpecSchema } from '../../clients/admission-policy-schemas.js'
import { admissionDescriptionSchema } from '../../clients/cluster-catalog.js'
import { clusterCapabilitiesShape } from '../../clients/cluster-capabilities.js'

const matchingSchema = admissionSpecSchema.shape.matchConstraints

export const policySummarySchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  kind: admissionDescriptionSchema.shape.kind,
  targets: matchingSchema,
  conditional: z.boolean(),
  bindings: z
    .array(
      z.object({
        name: z.string(),
        targets: matchingSchema,
        validationActions: z.array(z.string()).optional()
      })
    )
    .nullable()
})

// Only allowlisted matching metadata crosses the tool boundary. Never return
// policy specs, CEL expressions, variables, mutations or referenced parameters.
export function summarizePolicy(policy: z.infer<typeof admissionDescriptionSchema>) {
  return policySummarySchema.parse({
    name: policy.name,
    description: policy.description,
    kind: policy.kind,
    targets: compactMatching(policy.spec.matchConstraints),
    conditional: Boolean(policy.spec.matchConditions?.length || policy.spec.paramKind),
    bindings:
      policy.bindings?.map(binding => ({
        name: binding.name,
        targets: compactMatching(binding.spec.matchResources),
        validationActions: binding.spec.validationActions
      })) ?? null
  })
}

function compactMatching(value: z.infer<typeof matchingSchema>) {
  if (!value) return undefined

  const result = Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        item !== undefined &&
        key !== 'matchPolicy' &&
        (Array.isArray(item) ? item.length > 0 : typeof item !== 'object' || Object.keys(item).length > 0)
    )
  )

  return Object.keys(result).length ? result : undefined
}

export const capabilitySummaryShape = {
  customResources: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
  ingressClasses: clusterCapabilitiesShape.ingressClasses,
  clusterIssuers: z.array(z.object({ name: z.string(), description: z.string().nullable() })).nullable(),
  priorityClasses: clusterCapabilitiesShape.priorityClasses,
  degraded: clusterCapabilitiesShape.degraded
}

export function summarizeCapabilities(result: z.infer<z.ZodObject<typeof clusterCapabilitiesShape>>) {
  return {
    customResources: result.customResources.map(item => ({ name: item.name, description: item.description })),
    ingressClasses: result.ingressClasses,
    clusterIssuers:
      result.clusterIssuers?.map(item => ({ name: item.name, description: item.description })) ?? null,
    priorityClasses: result.priorityClasses,
    degraded: result.degraded
  }
}

export function csv(headers: string[], rows: unknown[][]): string {
  return (
    [headers, ...rows]
      .map(row =>
        row
          .map(value => {
            const text =
              value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

            return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
          })
          .join(',')
      )
      .join('\n') + '\n'
  )
}

function formatTargets(targets: z.infer<typeof matchingSchema>): string {
  if (!targets) return 'all'

  const rules = (items: NonNullable<z.infer<typeof matchingSchema>>['resourceRules']) =>
    items
      ?.map(rule =>
        [
          (rule.apiGroups ?? ['*'])
            .flatMap(group => (rule.resources ?? ['*']).map(resource => `${resource}.${group || 'core'}`))
            .join('|'),
          rule.apiVersions?.length ? `versions=${rule.apiVersions.join('|')}` : '',
          rule.operations?.length ? `operations=${rule.operations.join('|')}` : '',
          rule.resourceNames?.length ? `names=${rule.resourceNames.join('|')}` : '',
          rule.scope && rule.scope !== '*' ? `scope=${rule.scope}` : ''
        ]
          .filter(Boolean)
          .join(' ')
      )
      .join('; ')
  const selectors = [targets.namespaceSelector, targets.objectSelector].map((selector, index) => {
    if (!selector) return ''

    const terms = [
      ...Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`),
      ...(selector.matchExpressions ?? []).map(
        term => `${term.key} ${term.operator} (${(term.values ?? []).join('|')})`
      )
    ]

    return terms.length ? `${index === 0 ? 'namespace' : 'object'}: ${terms.join(' & ')}` : ''
  })

  return [
    rules(targets.resourceRules) || 'all',
    targets.excludeResourceRules?.length ? `exclude: ${rules(targets.excludeResourceRules)}` : '',
    ...selectors
  ]
    .filter(Boolean)
    .join('; ')
}

export function policyCatalogCsv(result: {
  policies: z.infer<typeof admissionDescriptionSchema>[]
  unavailableKinds: string[]
}): string {
  const rows = result.policies
    .map(summarizePolicy)
    .map(policy => [
      policy.name,
      policy.description,
      policy.kind,
      formatTargets(policy.targets),
      policy.bindings === null
        ? 'unavailable'
        : policy.bindings.length === 0
          ? 'none'
          : policy.bindings
              .map(
                binding =>
                  `${binding.name}: ${formatTargets(binding.targets)}${binding.validationActions?.length ? ' [' + binding.validationActions.join('|') + ']' : ''}`
              )
              .join('; '),
      policy.conditional
    ])

  return (
    csv(['name', 'description', 'kind', 'targets', 'bindings', 'conditional'], rows) +
    (result.unavailableKinds.length
      ? `\nUnavailable policy APIs: ${result.unavailableKinds.join(', ')}\n`
      : '')
  )
}

export function capabilityCatalogCsv(result: z.infer<z.ZodObject<typeof clusterCapabilitiesShape>>): string {
  const summary = summarizeCapabilities(result)

  return [
    'Custom resource definitions',
    csv(
      ['name', 'description'],
      summary.customResources.map(item => [item.name, item.description])
    ),
    'Cluster issuers',
    summary.clusterIssuers === null
      ? 'Unavailable'
      : csv(
          ['name', 'description'],
          summary.clusterIssuers.map(item => [item.name, item.description])
        ),
    'Ingress classes',
    summary.ingressClasses === null
      ? 'Unavailable'
      : csv(
          ['name', 'controller', 'default'],
          summary.ingressClasses.map(item => [item.name, item.controller, item.isDefault])
        ),
    'Priority classes',
    summary.priorityClasses === null
      ? 'Unavailable'
      : csv(
          ['name', 'description', 'value', 'default'],
          summary.priorityClasses.map(item => [item.name, item.description, item.value, item.isDefault])
        ),
    ...(summary.degraded.length
      ? [
          'Discovery errors',
          csv(
            ['source', 'message'],
            summary.degraded.map(item => [item.source, item.message])
          )
        ]
      : [])
  ].join('\n')
}
