import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  metricsInput,
  logsInput,
  type ObservabilityService,
  type ObservabilityCaller
} from '../../services/observability-service.js'
import type { ToolCallContext } from './caller-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export interface ObservabilityIdentityMapping {
  usernamePrefix: string
  groupsPrefix: string
}

// Identity comes only from the verified transport context, never tool arguments
// or caller-supplied namespace claims. The mapping must match kube-apiserver.
export function observabilityCaller(
  context: ToolCallContext,
  mapping: ObservabilityIdentityMapping
): ObservabilityCaller | undefined {
  const extra = context.authInfo?.extra

  if (typeof extra?.sub !== 'string' || !extra.sub) return undefined

  const groups = Array.isArray(extra.groups)
    ? extra.groups.filter((group): group is string => typeof group === 'string')
    : []

  return {
    identity: {
      user: `${mapping.usernamePrefix}${extra.sub}`,
      groups: [
        ...new Set(['system:authenticated', ...groups.map(group => `${mapping.groupsPrefix}${group}`)])
      ]
    }
  }
}

export function registerObservabilityTools(
  server: McpServer,
  service: ObservabilityService,
  mapping: ObservabilityIdentityMapping
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
