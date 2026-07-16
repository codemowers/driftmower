import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { WorkloadSearchService } from '../services/workload-search-service.js'
import { registerSearchWorkloadsTool } from './tools/search-workloads.js'

export const SERVER_NAME = 'driftmower-mcp'
export const SERVER_VERSION = '0.0.1'

export interface ServerDependencies {
  workloadSearchService: Pick<WorkloadSearchService, 'searchWorkloads'>
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  })

  registerSearchWorkloadsTool(server, dependencies.workloadSearchService)

  return server
}
