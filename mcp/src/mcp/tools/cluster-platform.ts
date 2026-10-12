import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClusterIdentity } from '../../domain/cluster-identity.js'
import { clusterIdentitySchema } from '../../domain/cluster-identity.js'
import { clusterPlatformSchema, type ClusterPlatformDiscovery } from '../../clients/cluster-platform.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerClusterPlatformTool(
  server: McpServer,
  discovery: ClusterPlatformDiscovery,
  cluster: ClusterIdentity
): void {
  server.registerTool(
    'get_cluster_platform',
    {
      title: 'Identify the Kubernetes platform',
      description:
        'Report k3s, vanilla Kubernetes, EKS, AKS or unknown, with provenance and evidence. Uses administrator configuration or live API version and node metadata. Does not infer vanilla from missing cloud markers. The platform result does not establish operator or managed service availability; discover those capabilities separately.',
      inputSchema: {},
      outputSchema: { cluster: clusterIdentitySchema, platform: clusterPlatformSchema },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      if (typeof context.authInfo?.extra?.sub !== 'string' || !context.authInfo.extra.sub) {
        throw new Error('Cluster platform discovery requires an authenticated caller')
      }

      const result = { cluster, platform: await discovery.describe() }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
