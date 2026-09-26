import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { accessibleNamespacesSchema, type NamespaceAccess } from '../../clients/namespace-access.js'
import { observabilityCaller, type ObservabilityIdentityMapping } from './observability.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerAccessibleNamespacesTool(
  server: McpServer,
  service: NamespaceAccess,
  mapping: ObservabilityIdentityMapping
): void {
  server.registerTool(
    'list_accessible_namespaces',
    {
      title: 'List accessible namespaces',
      description:
        'List all namespaces if Kubernetes permits the caller to list namespaces. Otherwise list namespaces with a RoleBinding to the configured role (KUBERNETES_NAMESPACE_ROLE, default admin) matching the caller or their groups. This discovery result does not replace per-operation authorization.',
      inputSchema: {},
      outputSchema: accessibleNamespacesSchema,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      const caller = observabilityCaller(context, mapping)

      if (!caller) throw new Error('Namespace discovery requires an authenticated caller')

      const result = await service.listAccessibleNamespaces(caller.identity)

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
