import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ImageUpdatePlanningService } from '../services/image-update-planning-service.js'
import type { ProvisioningService } from '../services/provisioning-service.js'
import type { WorkloadSearchService } from '../services/workload-search-service.js'
import { registerPlanImageUpdatesTool } from './tools/plan-image-updates.js'
import { registerProvisioningTools } from './tools/provisioning.js'
import { registerSearchWorkloadsTool } from './tools/search-workloads.js'

export const SERVER_NAME = 'driftmower-mcp'
// Advertised to clients in the initialize handshake. Kept in step with
// package.json, which is also what CI tags the image with.
export const SERVER_VERSION = '0.3.0'

export interface ServerDependencies {
  workloadSearchService: Pick<WorkloadSearchService, 'searchWorkloads'>
  imageUpdatePlanningService: Pick<ImageUpdatePlanningService, 'planImageUpdates'>
  // Absent when no driftmower-ui base URL is configured. The provisioning tools
  // are then not registered at all, which tells a client the truth up front
  // rather than advertising tools that always fail.
  provisioningService?: ProvisioningService
  audit?: (line: string) => void
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  })

  registerSearchWorkloadsTool(server, dependencies.workloadSearchService)
  registerPlanImageUpdatesTool(server, dependencies.imageUpdatePlanningService)

  if (dependencies.provisioningService) {
    registerProvisioningTools(server, {
      provisioningService: dependencies.provisioningService,
      audit: dependencies.audit
    })
  }

  return server
}
