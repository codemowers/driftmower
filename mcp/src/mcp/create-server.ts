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
    dependencies.provisioning &&
      'When planning an application or provisioning resources, start with describe_provisioning_platform for discovered platform facts, then list_offerings for relevant databases, caches, queues or object stores. Supply offering and the intended namespace when known. Before drafting manifests, use describe_namespace_readiness for the target namespaces and selected offering; use check_access for operations outside the offering catalog. Read structuredContent and warnings: unavailable or unknown facts are not evidence that a capability is absent, and authorization does not guarantee admission.',
    dependencies.provisioning &&
      'Offering presets describe sizing intent, not effective configuration or established high availability. Derive managed replica counts and fields to omit from applicable policy descriptions and bindings; a permitted range is not a configured count. Verify placement, storage behavior, persistence, backups and recovery separately before claiming resilience. Use namespace readiness to account for quota, LimitRange defaults, Pod Security and network constraints before deployment; choose explicit workload resources when defaults cannot support the application. Reuse facts already gathered for the same target; repeat discovery when relevant state changes or a fact is missing. Namespace readiness lists creatable resource names; use check_access for one specific operation.',
    dependencies.clusterCapabilities &&
      'Use list_custom_resource_definitions to discover installed custom-resource APIs beyond the offering catalog, then describe_custom_resource_definition for the selected API before drafting its manifest. Discover ingress classes, cluster issuers and priority classes with the corresponding list tools only when needed. Installed APIs and catalog entries do not establish controller health or permission to use them.',
    dependencies.clusterCapabilities &&
      dependencies.provisioning &&
      'Supply the target namespace to list_custom_resource_definitions to list only custom-resource APIs the caller can create there, without a permission matrix.',
    dependencies.clusterCatalog &&
      'Use list_admission_policies to discover policies and their bindings for the intended resource and namespace before relying on admission defaults or requirements. Use list_storage_classes when selecting volume storage. Keep each resource or policy’s own defaults and requirements separate; do not assume optional components or redirect to an alternative whose availability has not been discovered.',
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
  const instructions = [clusterInstructions(cluster), usageInstructions].join(' ')
  const server = new McpServer(
    {
      name: cluster.mcpServerName,
      version: SERVER_VERSION
    },
    { instructions }
  )

  server.registerResource(
    'cluster-discovery-guide',
    'driftmower://cluster/discovery-guide',
    {
      title: 'Cluster identity and discovery workflow',
      description:
        'Start here for this connection’s cluster identity and enabled discovery, provisioning and observability tool workflow. Live facts come from the listed tools.',
      mimeType: 'text/plain'
    },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: instructions }] })
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
      outputSchema: {
        cluster: clusterIdentitySchema,
        contextSelection: z.string(),
        discoveryInstructions: z.string()
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      const result = {
        cluster,
        contextSelection: clusterInstructions(cluster),
        discoveryInstructions: usageInstructions
      }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  if (dependencies.clusterCapabilities)
    registerClusterCapabilitiesTool(
      server,
      dependencies.clusterCapabilities,
      cluster,
      dependencies.provisioning
    )

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
