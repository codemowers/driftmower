import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClusterIdentity } from '../../domain/cluster-identity.js'
import { kubernetesRoleSchema, type KubernetesRoleDiscovery } from '../../clients/kubernetes-role.js'
import { observabilityCaller } from './observability.js'
import type { KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerKubernetesRoleTool(
  server: McpServer,
  service: KubernetesRoleDiscovery,
  mapping: KubernetesIdentityMapping,
  cluster: ClusterIdentity
): void {
  server.registerTool(
    'get_kubernetes_role',
    {
      title: 'Report your Kubernetes role',
      description:
        'Report cluster-admin or restricted from ClusterRoleBindings matching your authenticated username and groups. Namespace RoleBindings do not establish a cluster-wide role. Use admin@<cluster> for cluster-admin; otherwise use <cluster>/<namespace>. Missing role bindings do not rule out custom permissions. Read failures are errors, not restricted results.',
      inputSchema: {},
      outputSchema: { role: kubernetesRoleSchema, context: z.string(), contextSelection: z.string() },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, extra) => {
      const caller = observabilityCaller(extra, mapping)

      if (!caller) throw new Error('Role discovery requires an authenticated caller')

      const role = await service.getRole(caller.identity)
      const name = cluster.id ?? '<cluster>'
      const context = role === 'cluster-admin' ? `admin@${name}` : `${name}/<namespace>`
      const result = {
        role,
        context,
        contextSelection:
          role === 'cluster-admin'
            ? `Use the existing ${context} kubeconfig context with explicit --context; specify the target namespace with --namespace for namespaced operations. Verify its API server URL against this connection before use.`
            : `Use a ${context} kubeconfig context with context.namespace set to the target namespace. Verify its API server URL against this connection before use.`
      }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
