import { fetchJson } from "@/lib/utils/fetch-json"
import { pairVolumes, type PodVolume, type PromQuery, type ResourceTriplet } from "./query"

export type { PodVolume, ResourceTriplet } from "./query"

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

export function fetchPodMetrics(namespace: string, pod: string): Promise<PodMetrics | null> {
  const params = new URLSearchParams({ namespace, pod })
  return fetchJson<PodMetrics | null>(`/api/prometheus/pod-metrics?${params}`)
}

export async function loadPodMetrics(prom: PromQuery, namespace: string, pod: string): Promise<PodMetrics | null> {
  const q = podMetricQueries(namespace, pod)
  const [memUsage, memLimit, memRequest, cpuUsage, cpuLimit, cpuRequest, usedRows, capacityRows, qosRows] = await Promise.all([
    prom.scalar(q.memUsage),
    prom.scalar(q.memLimit),
    prom.scalar(q.memRequest),
    prom.scalar(q.cpuUsage),
    prom.scalar(q.cpuLimit),
    prom.scalar(q.cpuRequest),
    prom.vector(q.volUsed),
    prom.vector(q.volCapacity),
    prom.vector(q.qos),
  ])

  const volumes = pairVolumes(usedRows, capacityRows)
  const qosClass = qosRows.find(row => Number(row.value[1]) === 1)?.metric.qos_class
    ?? qosRows[0]?.metric.qos_class
    ?? null

  const allScalarsNull =
    memUsage === null && memLimit === null && memRequest === null &&
    cpuUsage === null && cpuLimit === null && cpuRequest === null

  if (allScalarsNull && volumes.length === 0) return null

  return {
    memory: { usage: memUsage, limit: memLimit, request: memRequest },
    cpu: { usage: cpuUsage, limit: cpuLimit, request: cpuRequest },
    volumes,
    qosClass,
  }
}
