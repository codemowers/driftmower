import { z } from 'zod'
import {
  clusterIdentitySchema,
  clusterInstructions,
  type ClusterIdentity
} from '../domain/cluster-identity.js'
import type { EngineeringAdvisory } from '../advisory/software-engineering.js'
import { READ_ONLY_ANNOTATIONS } from './tools/read-only-annotations.js'
import type { ClusterCapabilitiesDiscovery } from '../clients/cluster-capabilities.js'
import { registerClusterCapabilitiesTool } from './tools/cluster-capabilities.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ImageUpdatePlanningService } from '../services/image-update-planning-service.js'
import type { ProvisioningService } from '../services/provisioning-service.js'
import type { WorkloadSearchService } from '../services/workload-search-service.js'
import { registerPlanImageUpdatesTool } from './tools/plan-image-updates.js'
import { registerProvisioningTools } from './tools/provisioning.js'
import { registerSearchWorkloadsTool } from './tools/search-workloads.js'
import { registerObservabilityTools } from './tools/observability.js'
import type { KubernetesIdentityMapping } from '../auth/kubernetes-identity.js'
import type { ObservabilityService } from '../services/observability-service.js'
import type { ClusterCatalog } from '../clients/cluster-catalog.js'
import { registerClusterCatalogTools } from './tools/cluster-catalog.js'
import type { RbacScopeResolver } from '../clients/rbac-scope.js'
import { registerAccessibleNamespacesTool } from './tools/accessible-namespaces.js'
import { registerEngineeringAdvisory } from './resources/engineering-advisory.js'
import type { ScopeDependencies } from './tools/caller-scope.js'

export const SERVER_NAME = 'driftmower-mcp'
// Identify the running image in the MCP handshake; local builds report dev.
export const SERVER_VERSION = process.env.BUILD_REVISION ?? 'dev'

export interface ServerDependencies {
  cluster?: ClusterIdentity
  advisories?: EngineeringAdvisory[]
  namespaceScope?: { resolver: RbacScopeResolver; identityMapping: KubernetesIdentityMapping }
  clusterCapabilities?: ClusterCapabilitiesDiscovery
  clusterCatalog?: ClusterCatalog
  workloadSearchService?: Pick<WorkloadSearchService, 'searchWorkloads'>
  imageUpdatePlanningService?: Pick<ImageUpdatePlanningService, 'planImageUpdates'>
  observability?: { service: ObservabilityService; identityMapping: KubernetesIdentityMapping }
  provisioning?: { service: ProvisioningService; identityMapping: KubernetesIdentityMapping }
  // How search_workloads and plan_image_updates confine results. Absent means
  // the token claim alone.
  tenancy?: ScopeDependencies
  audit?: (line: string) => void
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const cluster = dependencies.cluster ?? { id: null, apiUrl: null, mcpServerName: SERVER_NAME }
  const server = new McpServer(
    {
      name: cluster.mcpServerName,
      version: SERVER_VERSION
    },
    { instructions: clusterInstructions(cluster) }
  )

  server.registerTool(
    'get_cluster_identity',
    {
      title: 'Identify this cluster',
      description:
        'Identify the cluster for this MCP connection and its external Kubernetes API URL. Match that URL against local kubeconfig before selecting an explicit kubectl context. Null values mean unconfigured identity; ask rather than guessing.',
      inputSchema: {},
      outputSchema: { cluster: clusterIdentitySchema, contextSelection: z.string() },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      const result = { cluster, contextSelection: clusterInstructions(cluster) }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  registerEngineeringAdvisory(server, dependencies.advisories, cluster)

  if (dependencies.clusterCapabilities)
    registerClusterCapabilitiesTool(server, dependencies.clusterCapabilities, cluster)

  if (dependencies.clusterCatalog) registerClusterCatalogTools(server, dependencies.clusterCatalog)

  if (dependencies.namespaceScope)
    registerAccessibleNamespacesTool(
      server,
      dependencies.namespaceScope.resolver,
      dependencies.namespaceScope.identityMapping
    )

  const tenancy = dependencies.tenancy
    ? { ...dependencies.tenancy, audit: dependencies.tenancy.audit ?? dependencies.audit }
    : undefined

  if (dependencies.workloadSearchService)
    registerSearchWorkloadsTool(server, dependencies.workloadSearchService, tenancy)

  if (dependencies.imageUpdatePlanningService)
    registerPlanImageUpdatesTool(server, dependencies.imageUpdatePlanningService, tenancy)

  if (dependencies.observability)
    registerObservabilityTools(
      server,
      dependencies.observability.service,
      dependencies.observability.identityMapping
    )

  if (dependencies.provisioning)
    registerProvisioningTools(server, {
      service: dependencies.provisioning.service,
      identityMapping: dependencies.provisioning.identityMapping,
      audit: dependencies.audit
    })

  return server
}
