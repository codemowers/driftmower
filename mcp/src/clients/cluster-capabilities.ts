import { z } from 'zod'
import { describeCrdDefinition, crdDetailsSchema } from './crd-details.js'

const metadata = z.object({
  name: z.string(),
  annotations: z.record(z.string(), z.string()).optional(),
  deletionTimestamp: z.string().nullish()
})
const conditions = z.array(z.object({ type: z.string(), status: z.string() })).optional()
const crd = z.object({
  metadata,
  spec: z.object({
    group: z.string(),
    names: z.object({ kind: z.string(), plural: z.string() }),
    scope: z.enum(['Namespaced', 'Cluster']),
    versions: z.array(z.object({ name: z.string(), served: z.boolean(), storage: z.boolean() }))
  }),
  status: z.object({ conditions }).optional()
})

export const customResourceSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  group: z.string(),
  kind: z.string(),
  resource: z.string(),
  scope: z.enum(['Namespaced', 'Cluster']),
  versions: z.array(z.object({ name: z.string(), served: z.boolean(), storage: z.boolean() })),
  established: z.boolean(),
  terminating: z.boolean()
})
export const clusterCapabilitiesShape = {
  customResources: z.array(customResourceSchema),
  capabilities: z.array(z.object({ name: z.string(), resources: z.array(z.string()) })),
  ingressClasses: z
    .array(z.object({ name: z.string(), controller: z.string(), isDefault: z.boolean() }))
    .nullable(),
  clusterIssuers: z
    .array(z.object({ name: z.string(), description: z.string().nullable(), ready: z.boolean().nullable() }))
    .nullable(),
  priorityClasses: z
    .array(
      z.object({
        name: z.string(),
        value: z.number(),
        isDefault: z.boolean(),
        description: z.string().nullable()
      })
    )
    .nullable(),
  degraded: z.array(z.object({ source: z.string(), message: z.string() })),
  relatedTools: z.array(z.string()),
  note: z.string()
}
export interface ClusterCapabilitiesDiscovery {
  describeCrd(name: string): Promise<z.infer<typeof crdDetailsSchema>>
  describe(): Promise<z.infer<z.ZodObject<typeof clusterCapabilitiesShape>>>
}

// Identify API families, not controller health or permission to provision instances.
const families: Record<string, string> = {
  'postgresql.cnpg.io': 'CloudNativePG',
  'dragonflydb.io': 'Dragonfly',
  'mongodbcommunity.mongodb.com': 'MongoDB Community',
  'rabbitmq.com': 'RabbitMQ',
  'cluster.redpanda.com': 'Redpanda',
  'opensearch.opster.io': 'OpenSearch',
  'opensearch.org': 'OpenSearch',
  'elasticsearch.k8s.elastic.co': 'Elasticsearch',
  'apps.emqx.io': 'EMQX',
  's3.onyxia.sh': 'S3 object storage',
  'secretgenerator.mittwald.de': 'Mittwald secret generator',
  'cert-manager.io': 'cert-manager',
  'trust.cert-manager.io': 'CA trust distribution',
  'codemowers.cloud': 'Codemowers platform',
  'monitoring.coreos.com': 'Prometheus monitoring APIs',
  'cilium.io': 'Cilium policy APIs'
}

export function createClusterCapabilities(
  read: (path: string) => Promise<string>
): ClusterCapabilitiesDiscovery {
  async function list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const items: T[] = []
    let continuation = ''

    // CRD schemas can be large; bound each response as well as the page count.
    for (let page = 0; page < 200; page += 1) {
      const query = new URLSearchParams({ limit: '10' })

      if (continuation) query.set('continue', continuation)

      const response = z
        .object({
          metadata: z.object({ continue: z.string().optional() }).optional(),
          items: z.array(schema)
        })
        .parse(JSON.parse(await read(`${path}?${query}`)))

      items.push(...response.items)
      continuation = response.metadata?.continue ?? ''

      if (!continuation) return items
    }

    throw new Error('Cluster capability discovery exceeded its page limit; incomplete results discarded')
  }

  return {
    async describeCrd(name) {
      const query = new URLSearchParams({ fieldSelector: `metadata.name=${name}`, limit: '1' })
      const response = z
        .object({ items: z.array(z.unknown()) })
        .parse(JSON.parse(await read(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions?${query}`)))

      if (response.items.length !== 1) throw new Error(`CRD not found: ${name}`)

      return describeCrdDefinition(response.items[0])
    },
    async describe() {
      // Failure here must never look like a cluster without installed CRDs.
      const customResources = (await list('/apis/apiextensions.k8s.io/v1/customresourcedefinitions', crd))
        .map(item => ({
          name: item.metadata.name,
          description: item.metadata.annotations?.['kubernetes.io/description'] ?? null,
          group: item.spec.group,
          kind: item.spec.names.kind,
          resource: item.spec.names.plural,
          scope: item.spec.scope,
          versions: item.spec.versions,
          established:
            item.status?.conditions?.some(c => c.type === 'Established' && c.status === 'True') ?? false,
          terminating: Boolean(item.metadata.deletionTimestamp)
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const degraded: { source: string; message: string }[] = []

      async function optional<T>(source: string, load: () => Promise<T>): Promise<T | null> {
        try {
          return await load()
        } catch (error) {
          degraded.push({ source, message: error instanceof Error ? error.message : 'Read failed' })

          return null
        }
      }

      const issuer = customResources.find(item => item.name === 'clusterissuers.cert-manager.io')
      const issuerVersion =
        issuer?.versions.find(v => v.served && v.name === 'v1') ?? issuer?.versions.find(v => v.served)
      const [ingressClasses, priorityClasses, clusterIssuers] = await Promise.all([
        optional('ingressclasses', async () =>
          (
            await list(
              '/apis/networking.k8s.io/v1/ingressclasses',
              z.object({ metadata, spec: z.object({ controller: z.string() }) })
            )
          ).map(item => ({
            name: item.metadata.name,
            controller: item.spec.controller,
            isDefault: item.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
          }))
        ),
        optional('priorityclasses', async () =>
          (
            await list(
              '/apis/scheduling.k8s.io/v1/priorityclasses',
              z.object({
                metadata,
                value: z.number(),
                globalDefault: z.boolean().optional(),
                description: z.string().optional()
              })
            )
          ).map(item => ({
            name: item.metadata.name,
            value: item.value,
            isDefault: item.globalDefault === true,
            description: item.description ?? null
          }))
        ),
        issuerVersion
          ? optional('clusterissuers', async () =>
              (
                await list(
                  `/apis/cert-manager.io/${encodeURIComponent(issuerVersion.name)}/clusterissuers`,
                  z.object({ metadata, status: z.object({ conditions }).optional() })
                )
              ).map(item => {
                const ready = item.status?.conditions?.find(c => c.type === 'Ready')?.status

                return {
                  name: item.metadata.name,
                  description: item.metadata.annotations?.['kubernetes.io/description'] ?? null,
                  ready: ready === 'True' ? true : ready === 'False' ? false : null
                }
              })
            )
          : Promise.resolve([])
      ])

      return {
        customResources,
        capabilities: Object.entries(families).flatMap(([group, name]) => {
          const resources = customResources
            .filter(
              item =>
                item.group === group &&
                item.established &&
                !item.terminating &&
                item.versions.some(v => v.served)
            )
            .map(item => `${item.kind}.${item.group}`)

          return resources.length ? [{ name, resources }] : []
        }),
        ingressClasses,
        priorityClasses,
        clusterIssuers,
        degraded: degraded.sort((a, b) => a.source.localeCompare(b.source)),
        relatedTools: [
          'list_storage_classes',
          'list_admission_policies',
          'list_accessible_namespaces',
          'get_engineering_advisory'
        ],
        note: 'CRDs describe installed APIs, not operator health, watched namespaces, or caller authorization. Issuer readiness is its reported condition. Consult storage and admission catalogs for provisioning constraints. No tenant resource instances or credentials are read.'
      }
    }
  }
}
