import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import { WorkloadActions, restartWorkloadInput, terminatePodInput } from '../../services/workload-actions.js'
import { observabilityCaller } from './observability.js'

export function registerWorkloadActions(
  server: McpServer,
  service: WorkloadActions,
  mapping: KubernetesIdentityMapping
): void {
  const annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  }

  server.registerTool(
    'restart_workload',
    {
      title: 'Restart a workload',
      description:
        'Mutating operation, available only when MCP_WORKLOAD_RESTART_ENABLED is true. Use only when the user requests a restart. Obtain namespace, name, UID, kind and apiVersion from current get_workloads inventory; never infer UID. Supports apps/v1 Deployment, StatefulSet and DaemonSet rollout restart, and postgresql.cnpg.io/v1 Cluster through its restart annotation. Supports Redpanda cluster.redpanda.com/v1alpha1 or v1alpha2 via clusterSpec.statefulset.podTemplate.annotations, and Dragonfly dragonflydb.io/v1alpha1 via spec.annotations; verifies the installed operator schema before patching. Operators manage pod recreation. Jobs, CronJobs, ReplicaSets and unknown operators are unsupported. Paused, OnDelete and partitioned rollouts are rejected. Executes as the verified Kubernetes caller: requires get and patch on the exact target, and admission still applies. UID/resourceVersion guard against stale inventory and concurrent changes. Returns request acceptance, not completed rollout or verified health. Can interrupt service; do not automatically retry an uncertain outcome.',
      inputSchema: restartWorkloadInput,
      annotations
    },
    async (input, context) => {
      const caller = observabilityCaller(context, mapping)

      if (!caller) throw new Error('Restart requires an authenticated caller')

      const result = await service.restart(input, caller.identity)

      return { structuredContent: result, content: [{ type: 'text', text: result.message }] }
    }
  )
  server.registerTool(
    'terminate_pod',
    {
      title: 'Terminate a standalone pod',
      description:
        'Mutating operation, available only when MCP_WORKLOAD_RESTART_ENABLED is true. Use only when the user explicitly requests termination of a standalone pod. Obtain name and UID from the namespace orphan bucket standalonePods in get_workloads. Requires get and delete pods as the verified caller. Rechecks live ownerReferences and rejects owned pods (including Job/CronJob pods) and static mirror pods. Deletes with UID/resourceVersion preconditions and the normal grace period; never force deletes. A standalone pod has no controller to recreate it. Returns termination acceptance, not completed deletion. Do not automatically retry an uncertain outcome.',
      inputSchema: terminatePodInput,
      annotations
    },
    async (input, context) => {
      const caller = observabilityCaller(context, mapping)

      if (!caller) throw new Error('Termination requires an authenticated caller')

      const result = await service.terminate(input, caller.identity)

      return { structuredContent: result, content: [{ type: 'text', text: result.message }] }
    }
  )
}
