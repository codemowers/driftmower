import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ImageUpdatePlanningService } from '../services/image-update-planning-service.js'
import type { WorkloadSearchService } from '../services/workload-search-service.js'
import { registerPlanImageUpdatesTool } from './tools/plan-image-updates.js'
import { registerSearchWorkloadsTool } from './tools/search-workloads.js'

export const SERVER_NAME = 'driftmower-mcp'
export const SERVER_VERSION = '0.0.3'

export interface ServerDependencies {
  workloadSearchService: Pick<WorkloadSearchService, 'searchWorkloads'>
  imageUpdatePlanningService: Pick<ImageUpdatePlanningService, 'planImageUpdates'>
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  })

  registerSearchWorkloadsTool(server, dependencies.workloadSearchService)
  registerPlanImageUpdatesTool(server, dependencies.imageUpdatePlanningService)

  return server
}
