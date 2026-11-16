import { fetchMcpJSON } from "@/browser/connection"
import { type PodVolume,type ResourceTriplet } from "./query"

export type PerPodMetrics = {
  podName: string
  memory: ResourceTriplet
  cpu: ResourceTriplet
  qosClass: string | null
}

export type WorkloadMetrics = {
  memory: ResourceTriplet
  cpu: ResourceTriplet
  volumes: PodVolume[]
  qosClass: string | null
  qosBreakdown: { qosClass: string; count: number }[]
  replicaCount: number
  perPod: PerPodMetrics[]
}

export function workloadMetricQueries(namespace: string, podNames: string[]) {
  const sel = `namespace="${namespace}",pod=~"(${podNames.join("|")})"`
  const pvcInfo = `kube_pod_spec_volumes_persistentvolumeclaims_info{${sel}}`
  return {
    memUsage: `sum by (pod)(container_memory_working_set_bytes{${sel},container!=""})`,
    memLimit: `sum by (pod)(kube_pod_container_resource_limits{${sel},resource="memory"})`,
    memRequest: `sum by (pod)(kube_pod_container_resource_requests{${sel},resource="memory"})`,
    cpuUsage: `sum by (pod)(rate(container_cpu_usage_seconds_total{${sel},container!=""}[5m]))`,
    cpuLimit: `sum by (pod)(kube_pod_container_resource_limits{${sel},resource="cpu"})`,
    cpuRequest: `sum by (pod)(kube_pod_container_resource_requests{${sel},resource="cpu"})`,
    volUsed: `kubelet_volume_stats_used_bytes and on(namespace,persistentvolumeclaim) ${pvcInfo}`,
    volCapacity: `kubelet_volume_stats_capacity_bytes and on(namespace,persistentvolumeclaim) ${pvcInfo}`,
    qos: `kube_pod_status_qos_class{${sel}}`,
  }
}

// Memory, CPU, QoS and PVC usage of a workload's current Pods, from MCP.
export async function fetchWorkloadMetrics(namespace: string, workloadUid: string, signal?: AbortSignal): Promise<WorkloadMetrics | null> {
  if (!namespace || !workloadUid) return null
  return fetchMcpJSON<WorkloadMetrics>(`/api/observability/workload-resources?${new URLSearchParams({namespace, uid: workloadUid})}`, { signal })
}
