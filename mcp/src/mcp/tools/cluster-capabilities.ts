import { z } from 'zod'
import { crdDetailsSchema } from '../../clients/crd-details.js'
import type { ClusterIdentity } from '../../domain/cluster-identity.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type ClusterCapabilitiesDiscovery } from '../../clients/cluster-capabilities.js'
import { capabilityCatalogCsv } from './catalog-summary.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerClusterCapabilitiesTool(
  server: McpServer,
  discovery: ClusterCapabilitiesDiscovery,
  cluster: ClusterIdentity
): void {
  server.registerTool(
    'describe_cluster_capabilities',
    {
      title: `Describe cluster capabilities (${cluster.id ?? 'identity unconfigured'})`,
      description:
        'Return CSV catalogs of CRD names and descriptions, ingress classes, TLS issuer descriptions and priority classes. Use describe_custom_resource_definition for a specific CRD schema. No resource status is returned. Installed APIs do not establish operator health or caller authorization.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      if (typeof context.authInfo?.extra?.sub !== 'string' || !context.authInfo.extra.sub) {
        throw new Error('Cluster capabilities require an authenticated caller')
      }

      const result = await discovery.describe()

      return { content: [{ type: 'text', text: capabilityCatalogCsv(result) }] }
    }
  )
  server.registerTool(
    'describe_custom_resource_definition',
    {
      title: 'Describe a custom resource definition',
      description:
        'Read one installed CRD by its full name from describe_cluster_capabilities. Returns served API versions and writable resource schemas; excludes status, controller metadata and CEL code.',
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
