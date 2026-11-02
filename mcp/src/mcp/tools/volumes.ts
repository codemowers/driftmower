import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { volumesInput, type VolumeService } from '../../services/volume-service.js'
import type { KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import { observabilityCaller } from './observability.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerVolumeTools(
  server: McpServer,
  service: VolumeService,
  mapping: KubernetesIdentityMapping
): void {
  server.registerTool(
    'list_volumes',
    {
      title: 'List PVCs, PVs and volume usage',
      description:
        'Use for storage inventory, PVC-to-PV bindings, allocation and volume space or inode usage. Specify namespace when known; omitting it requires cluster-wide list PVC permission. Kubernetes supplies PVC/PV metadata; Prometheus augments claims with kubelet used/capacity bytes and total/used inodes when configured. Bound PV details require get permission for each PV. Set includeUnboundPVs only when investigating Available, Released or other non-Bound PVs; it requires cluster-wide list PV permission. Missing usage is null, not zero. Includes source metrics and exact queries; never exports CSI attributes or secret references. For which workload consumes a PVC, use get_workloads when available.',
      inputSchema: volumesInput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (input, context) => {
      const result = await service.listVolumes(input, observabilityCaller(context, mapping))

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
