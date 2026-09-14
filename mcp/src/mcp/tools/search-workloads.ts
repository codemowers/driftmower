import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { WorkloadSearchService } from '../../services/workload-search-service.js'
import { callerScope } from './caller-scope.js'

export const SEARCH_WORKLOADS_TOOL_NAME = 'search_workloads'

export function registerSearchWorkloadsTool(
  server: McpServer,
  workloadSearchService: Pick<WorkloadSearchService, 'searchWorkloads'>
): void {
  server.registerTool(
    SEARCH_WORKLOADS_TOOL_NAME,
    {
      title: 'Search Driftmower workloads',
      description: 'Find workloads by name in latest full-cluster Driftmower report snapshots.',
      inputSchema: {
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).optional()
      }
    },
    async ({ query, limit }, context) => {
      const result = await workloadSearchService.searchWorkloads({
        query,
        limit,
        scope: callerScope(context)
      })

      return {
        structuredContent: { ...result },
        content: [
          {
            type: 'text',
            text: JSON.stringify(result)
          }
        ]
      }
    }
  )
}
