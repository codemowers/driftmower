import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import type { KubernetesReader, ObservabilityKubernetes } from '../../clients/observability-kubernetes.js'
import { collect } from '../../clients/kubernetes-list.js'
import { observabilityCaller } from './observability.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

const metadata = z.object({ metadata: z.object({ name: z.string() }) })

export function registerListPodsTool(
  server: McpServer,
  kubernetes: Pick<ObservabilityKubernetes, 'allowed'> & { read: KubernetesReader },
  mapping: KubernetesIdentityMapping
): void {
  server.registerTool(
    'list_pods',
    {
      title: 'List pod names',
      description:
        'Use when only current pod names in a known namespace are needed, such as choosing a pod for logs or resource usage. For application inventory, owner relationships and dependencies, prefer get_workloads when available. Requires authenticated list pods permission and reads metadata only. Returns sorted names; no pod status, containers or ownership. Deleted pods are absent; a known deleted pod name may still have resource usage history. An incomplete listing is an error.',
      inputSchema: {
        namespace: z
          .string()
          .max(63)
          .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
      },
      outputSchema: { namespace: z.string(), pods: z.array(z.string()) },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ namespace }, context) => {
      const caller = observabilityCaller(context, mapping)

      if (!caller) throw new Error('Pod listing requires an authenticated caller')

      if (
        !(await kubernetes.allowed(caller.identity, { namespace, group: '', resource: 'pods', verb: 'list' }))
      )
        throw new Error(`Kubernetes RBAC denied list pods in namespace ${namespace}`)

      const read: KubernetesReader = path =>
        kubernetes.read(
          path,
          'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json'
        )
      const pods = await collect(
        read,
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
        item => metadata.parse(item).metadata.name,
        { limit: 200, maxPages: 20, what: 'Pod listing' }
      )
      const result = { namespace, pods: [...new Set(pods)].sort() }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
