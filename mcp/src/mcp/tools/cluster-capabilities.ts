import { z } from 'zod'
import { crdDetailsSchema } from '../../clients/crd-details.js'
import type { ClusterIdentity } from '../../domain/cluster-identity.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type ClusterCapabilitiesDiscovery } from '../../clients/cluster-capabilities.js'
import { clusterCapabilitiesShape, customResourceSchema } from '../../clients/cluster-capabilities.js'
import { omitDefaultFlag } from './catalog-fields.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerClusterCapabilitiesTool(
  server: McpServer,
  discovery: ClusterCapabilitiesDiscovery,
  cluster: ClusterIdentity
): void {
  server.registerTool(
    'list_custom_resource_definitions',
    {
      title: `List custom resource definitions (${cluster.id ?? 'identity unconfigured'})`,
      description:
        'Use to discover which custom-resource APIs are installed before planning resources. Returns API identities and operator-authored descriptions, not existing CR instances or workloads. Defaults to Namespaced APIs; choose Cluster or All explicitly to include cluster-scoped APIs. Installed APIs do not establish operator health or caller authorization. Use describe_custom_resource_definition for a selected CRD schema; use get_workloads when available for existing workload roots.',
      inputSchema: { scope: z.enum(['Namespaced', 'Cluster', 'All']).default('Namespaced') },
      outputSchema: { customResources: z.array(customResourceSchema) },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ scope }, context) => {
      if (typeof context.authInfo?.extra?.sub !== 'string' || !context.authInfo.extra.sub)
        throw new Error('CRD discovery requires an authenticated caller')

      const customResources = (await discovery.listCustomResourceDefinitions()).filter(
        item => scope === 'All' || item.scope === scope
      )
      const result = { customResources }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
  const responseShapes = {
    ingressClasses: z
      .array(clusterCapabilitiesShape.ingressClasses.unwrap().element.omit({ isDefault: true }))
      .nullable(),
    priorityClasses: z
      .array(clusterCapabilitiesShape.priorityClasses.unwrap().element.omit({ isDefault: true }))
      .nullable(),
    clusterIssuers: clusterCapabilitiesShape.clusterIssuers
  }

  for (const [name, key, description] of [
    [
      'list_ingress_classes',
      'ingressClasses',
      'Use to choose an installed ingressClassName. Returns ingress classes and their controllers; class existence does not verify controller health, routing, DNS or TLS.'
    ],
    [
      'list_cluster_issuers',
      'clusterIssuers',
      'Use to discover available cluster-scoped cert-manager issuers before selecting one for a Certificate. Returns their own descriptions, reported readiness and ACME solver types when the API is installed. Null means the catalog is unavailable; an empty list means none were found. Do not infer namespace-scoped Issuer availability from this catalog.'
    ],
    [
      'list_priority_classes',
      'priorityClasses',
      'Use to choose an installed priorityClassName. Returns classes sorted by ascending numeric priority, with values and descriptions. Larger values have higher scheduling priority; class existence does not authorize its use or guarantee capacity.'
    ]
  ] as const) {
    server.registerTool(
      name,
      {
        title: name.replaceAll('_', ' '),
        description,
        inputSchema: {},
        outputSchema: { [key]: responseShapes[key], degraded: clusterCapabilitiesShape.degraded },
        annotations: READ_ONLY_ANNOTATIONS
      },
      async (_input, context) => {
        if (typeof context.authInfo?.extra?.sub !== 'string' || !context.authInfo.extra.sub)
          throw new Error('Cluster catalog requires an authenticated caller')

        let version: string | null = null

        if (key === 'clusterIssuers') {
          const issuer = (await discovery.listCustomResourceDefinitions()).find(
            item => item.name === 'clusterissuers.cert-manager.io' && item.established && !item.terminating
          )

          version =
            (
              issuer?.versions.find(item => item.served && item.name === 'v1') ??
              issuer?.versions.find(item => item.served)
            )?.name ?? null
        }

        const catalog = await discovery.listPlatformClasses(version, key)
        const entries = catalog[key]
        const result = { [key]: entries?.map(omitDefaultFlag) ?? null, degraded: catalog.degraded }

        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
    )
  }

  server.registerTool(
    'describe_custom_resource_definition',
    {
      title: 'Describe a custom resource definition',
      description:
        'Use after selecting a CRD from list_custom_resource_definitions to inspect its writable fields before drafting a custom resource. Supply the full CRD name (plural.group), not Kind.group or an object name. Returns served API versions and writable resource schemas; excludes status, controller metadata and CEL code.',
      inputSchema: { name: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/) },
      outputSchema: crdDetailsSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ name }, context) => {
      if (typeof context.authInfo?.extra?.sub !== 'string' || !context.authInfo.extra.sub) {
        throw new Error('CRD discovery requires an authenticated caller')
      }

      const result = await discovery.describeCrd(name)

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
