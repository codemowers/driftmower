import { fetchMcpJSON } from "@/browser/connection"
import { type PodVolume,type ResourceTriplet } from "./query"

export type { PodVolume,ResourceTriplet } from "./query"

export type PodMetrics = {
  memory: ResourceTriplet
  cpu: ResourceTriplet
  volumes: PodVolume[]
  qosClass: string | null
}

export function podMetricQueries(namespace: string, pod: string) {
  const sel = `namespace="${namespace}",pod="${pod}"`
  const pvcInfo = `kube_pod_spec_volumes_persistentvolumeclaims_info{${sel}}`
  return {
    memUsage: `sum by (pod)(container_memory_working_set_bytes{${sel},container!=""})`,
    memLimit: `sum(kube_pod_container_resource_limits{${sel},resource="memory"})`,
    memRequest: `sum(kube_pod_container_resource_requests{${sel},resource="memory"})`,
    cpuUsage: `sum by (pod)(rate(container_cpu_usage_seconds_total{${sel},container!=""}[5m]))`,
    cpuLimit: `sum(kube_pod_container_resource_limits{${sel},resource="cpu"})`,
    cpuRequest: `sum(kube_pod_container_resource_requests{${sel},resource="cpu"})`,
    volUsed: `kubelet_volume_stats_used_bytes and on(namespace,persistentvolumeclaim) ${pvcInfo}`,
    volCapacity: `kubelet_volume_stats_capacity_bytes and on(namespace,persistentvolumeclaim) ${pvcInfo}`,
    qos: `kube_pod_status_qos_class{${sel}}`,
  }
}

// One Pod of a workload, through the same MCP tool as the whole workload.
export async function fetchPodMetrics(namespace: string, workloadUid: string, pod: string, signal?: AbortSignal): Promise<PodMetrics | null> {
  if (!namespace || !workloadUid || !pod) return null
  return fetchMcpJSON<PodMetrics>(`/api/observability/workload-resources?${new URLSearchParams({namespace, uid: workloadUid, pod})}`, { signal })
}
