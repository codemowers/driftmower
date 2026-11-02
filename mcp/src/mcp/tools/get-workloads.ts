import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { workloadsInput, workloadsOutput, type WorkloadListing } from '../../clients/workloads.js'
import { observabilityCaller } from './observability.js'
import type { KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export function registerGetWorkloadsTool(
  server: McpServer,
  service: WorkloadListing,
  mapping: KubernetesIdentityMapping
): void {
  server.registerTool(
    'get_workloads',
    {
      title: 'Get live workloads',
      description:
        'Start here for questions about applications, workloads, what runs in a namespace, or which resources belong together. Specify namespace when known; omit it only for a cross-namespace overview of namespaces visible to the caller. Returns current root owners with pods, images, ConfigMaps, Secrets, PVCs, Services, Ingresses and Certificates; shared dependencies may appear under several roots. Includes scaled-to-zero built-in controllers. Built-in controller ancestry is resolved recursively; custom roots are terminal owner references marked ownerReferenceOnly unless a fixed adapter verifies them. When the CNPG API is available and the caller can list Clusters, a fixed adapter associates explicit TLS Secret and monitoring query references; it does not verify health or traverse further custom ancestry. Certificates join consumers through pod Secret references or associated Ingress TLS. Namespace/orphaned-workloads holds unclaimed resources; its orphaned mapping groups auxiliary generating owners by Kind.api-group and name. Unused kube-root-ca.crt ConfigMaps, reflected copies, trust-manager bundles and Helm release records are excluded from orphan buckets; consumed copies remain workload dependencies. Orphaned does not mean safe to delete. Namespace orphan buckets also include standalonePods name/UID pairs for ownerless, non-static pods. Empty lists and empty orphan buckets are omitted. Read workloads in structuredContent; the text content is only a count and warning summary. Requires authenticated list pods permission; each collection is additionally filtered by caller list permission. Warnings identify incomplete inventory: missing objects or dependencies must not be treated as confirmed absent. Secret and ConfigMap contents are never returned. Watch-backed cached snapshot with opaque revision; no resource-usage or historical analysis.',
      inputSchema: workloadsInput,
      outputSchema: workloadsOutput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (input, context) => {
      const caller = observabilityCaller(context, mapping)

      if (!caller) throw new Error('Workload listing requires an authenticated caller')

      const result = await service.listWorkloads(input, caller.identity)

      return {
        structuredContent: result,
        content: [
          {
            type: 'text',
            text: `${result.workloads.filter(workload => workload.kind !== 'Namespace').length} workloads; ${result.workloads.filter(workload => workload.kind === 'Namespace').length} namespace orphan buckets.${result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''}`
          }
        ]
      }
    }
  )
}
