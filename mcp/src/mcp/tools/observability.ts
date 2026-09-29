import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  metricsInput,
  logsInput,
  type ObservabilityService,
  type ObservabilityCaller
} from '../../services/observability-service.js'
import { kubernetesIdentityFor, type KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import type { ToolCallContext } from './caller-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

// Identity comes only from the verified transport context, never tool arguments
// or caller-supplied namespace claims. See kubernetesIdentityFor.
export function observabilityCaller(
  context: ToolCallContext,
  mapping: KubernetesIdentityMapping
): ObservabilityCaller | undefined {
  const resolved = kubernetesIdentityFor(context.authInfo, mapping)

  return resolved.ok ? { identity: resolved.identity } : undefined
}

export function registerObservabilityTools(
  server: McpServer,
  service: ObservabilityService,
  mapping: KubernetesIdentityMapping
): void {
  if (service.metricsEnabled) {
    server.registerTool(
      'query_metrics',
      {
        title: 'Query namespace metrics',
        description:
          'Query a Prometheus metric in one namespace authorized by Kubernetes RBAC (list pods). Use exact label filters, optional rate/increase and aggregation. Supply start and end for a range query. Only metrics with a namespace label are supported.',
        inputSchema: metricsInput,
        annotations: READ_ONLY_ANNOTATIONS
      },
      async (input, context) => {
        const result = await service.queryMetrics(input, observabilityCaller(context, mapping))

        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
    )
  }

  server.registerTool(
    'query_logs',
    {
      title: 'Query pod logs',
      description:
        'Query logs for one pod in a namespace authorized by Kubernetes RBAC (get pods/log). Defaults to the last hour, newest first. Uses Loki when LOKI_URL is configured, otherwise bounded current container logs via Kubernetes. Specify container for multi-container pods.',
      inputSchema: logsInput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (input, context) => {
      const result = await service.queryLogs(input, observabilityCaller(context, mapping))

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
