import { z } from 'zod'

const versionSchema = z.object({
  name: z.string(),
  served: z.boolean(),
  schema: z.object({ openAPIV3Schema: z.record(z.string(), z.unknown()) }).optional()
})
const definitionSchema = z.object({
  metadata: z.object({ name: z.string(), annotations: z.record(z.string(), z.string()).optional() }),
  spec: z.object({
    group: z.string(),
    names: z.object({ kind: z.string(), plural: z.string() }),
    scope: z.enum(['Namespaced', 'Cluster']),
    versions: z.array(versionSchema)
  })
})

export const crdDetailsSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  group: z.string(),
  kind: z.string(),
  resource: z.string(),
  scope: z.enum(['Namespaced', 'Cluster']),
  versions: z.array(z.object({ name: z.string(), schema: z.record(z.string(), z.unknown()).nullable() }))
})

// Retain schema structure, but omit server-owned fields and embedded CEL.
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema)

  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (key === 'x-kubernetes-validations') return []

      if (key === 'properties' && child && typeof child === 'object') {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child)
                .filter(([name]) => name !== 'status')
                .map(([name, schema]) => [name, cleanSchema(schema)])
            )
          ]
        ]
      }

      if (key === 'required' && Array.isArray(child)) return [[key, child.filter(name => name !== 'status')]]

      return [[key, cleanSchema(child)]]
    })
  )
}

export function describeCrdDefinition(input: unknown): z.infer<typeof crdDetailsSchema> {
  const item = definitionSchema.parse(input)

  return crdDetailsSchema.parse({
    name: item.metadata.name,
    description: item.metadata.annotations?.['kubernetes.io/description'] ?? null,
    group: item.spec.group,
    kind: item.spec.names.kind,
    resource: item.spec.names.plural,
    scope: item.spec.scope,
    versions: item.spec.versions
      .filter(version => version.served)
      .map(version => ({
        name: version.name,
        schema: version.schema ? cleanSchema(version.schema.openAPIV3Schema) : null
      }))
  })
}
