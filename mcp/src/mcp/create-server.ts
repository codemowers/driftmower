import { registerWorkloadActions } from './tools/workload-actions.js'
import type { WorkloadActions } from '../services/workload-actions.js'
import { registerGetWorkloadsTool } from './tools/get-workloads.js'
import type { WorkloadListing } from '../clients/workloads.js'
import { registerVolumeTools } from './tools/volumes.js'
import type { VolumeService } from '../services/volume-service.js'
import { registerListPodsTool } from './tools/list-pods.js'
import type { KubernetesReader, ObservabilityKubernetes } from '../clients/observability-kubernetes.js'
import { z } from 'zod'
import {
  clusterIdentitySchema,
  clusterInstructions,
  type ClusterIdentity
} from '../domain/cluster-identity.js'
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
import type { ScopeDependencies } from './tools/caller-scope.js'

export const SERVER_NAME = 'driftmower-mcp'
// Identify the running image in the MCP handshake; local builds report dev.
export const SERVER_VERSION = process.env.BUILD_REVISION ?? 'dev'

export interface ServerDependencies {
  workloadActions?: { service: WorkloadActions; identityMapping: KubernetesIdentityMapping }
  workloads?: { service: WorkloadListing; identityMapping: KubernetesIdentityMapping }
  cluster?: ClusterIdentity
  namespaceScope?: { resolver: RbacScopeResolver; identityMapping: KubernetesIdentityMapping }
  clusterCapabilities?: ClusterCapabilitiesDiscovery
  clusterCatalog?: ClusterCatalog
  workloadSearchService?: Pick<WorkloadSearchService, 'searchWorkloads'>
  imageUpdatePlanningService?: Pick<ImageUpdatePlanningService, 'planImageUpdates'>
  volumes?: { service: VolumeService; identityMapping: KubernetesIdentityMapping }
  podListing?: {
    kubernetes: Pick<ObservabilityKubernetes, 'allowed'> & { read: KubernetesReader }
    identityMapping: KubernetesIdentityMapping
  }
  observability?: { service: ObservabilityService; identityMapping: KubernetesIdentityMapping }
  provisioning?: { service: ProvisioningService; identityMapping: KubernetesIdentityMapping }
  // How search_workloads and plan_image_updates confine results. Absent means
  // the token claim alone.
  tenancy?: ScopeDependencies
  audit?: (line: string) => void
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const cluster = dependencies.cluster ?? { id: null, apiUrl: null, mcpServerName: SERVER_NAME }
  const usageInstructions = [
    dependencies.workloads &&
      'For applications, workload discovery, what runs in a namespace, and resource relationships, start with get_workloads. Use a specified namespace directly; omit namespace only for an overview. Its text is a summary; read structuredContent for the inventory and inspect warnings before claiming completeness.',
    dependencies.namespaceScope &&
      'Use list_accessible_namespaces when namespace scope is unknown; visibility does not imply write permission.',
    dependencies.observability &&
      dependencies.observability.service.metricsEnabled &&
      'For current resource usage, prefer get_pod_resource_usage or get_cluster_resource_usage. Use their history endpoints only for trends, past usage, peaks or statistics. Use query_metrics for specific metrics outside those fixed summaries. Missing metrics or low coverage are not evidence of zero usage.',
    dependencies.workloadSearchService &&
      'search_workloads reads backend report snapshots and may be stale or differently scoped; use live workload inventory when available for what is running now.',
    dependencies.workloadActions &&
      'restart_workload and terminate_pod mutate resources. Use only for an explicit user request, using UID from current workload inventory; never treat them as diagnostic probes or automatically retry uncertain results.',
    'Use only tools exposed by this connection. Narrow requests to the namespace, pod, metric or resource needed; avoid collecting unrelated namespaces or histories.'
  ]
    .filter(Boolean)
    .join(' ')
  const server = new McpServer(
    {
      name: cluster.mcpServerName,
      version: SERVER_VERSION
    },
    { instructions: [clusterInstructions(cluster), usageInstructions].join(' ') }
  )

  if (dependencies.workloads)
    registerGetWorkloadsTool(server, dependencies.workloads.service, dependencies.workloads.identityMapping)

  if (dependencies.workloadActions)
    registerWorkloadActions(
      server,
      dependencies.workloadActions.service,
      dependencies.workloadActions.identityMapping
    )

  server.registerTool(
    'get_cluster_identity',
    {
      title: 'Identify this cluster',
      description:
        'Use to identify the cluster and external Kubernetes API URL for this connection, especially before selecting a kubectl context or interpreting backend report scope. Match that URL against local kubeconfig before selecting an explicit kubectl context. Null values mean unconfigured identity; ask rather than guessing.',
      inputSchema: {},
      outputSchema: { cluster: clusterIdentitySchema, contextSelection: z.string() },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      const result = { cluster, contextSelection: clusterInstructions(cluster) }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

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

  if (dependencies.volumes)
    registerVolumeTools(server, dependencies.volumes.service, dependencies.volumes.identityMapping)

  if (dependencies.podListing)
    registerListPodsTool(server, dependencies.podListing.kubernetes, dependencies.podListing.identityMapping)

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
