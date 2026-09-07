import { pairVolumes, queryVector, type PodVolume, type ResourceTriplet, type VectorRow } from "./query"

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

const QOS_ORDER = ["guaranteed", "burstable", "besteffort"]

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

function byPod(rows: VectorRow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const row of rows) {
    const pod = row.metric.pod
    const value = Number(row.value[1])
    if (pod && Number.isFinite(value)) m.set(pod, value)
  }
  return m
}

function qosByPod(rows: VectorRow[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const row of rows) {
    const pod = row.metric.pod
    const cls = row.metric.qos_class
    if (!pod || !cls) continue
    if (Number(row.value[1]) === 1 || !m.has(pod)) m.set(pod, cls)
  }
  return m
}

function aggregate(usageByPod: Map<string, number>, limitByPod: Map<string, number>): { usage: number | null; limit: number | null } {
  const pods = [...usageByPod.keys()]
  if (pods.length === 0) return { usage: null, limit: null }
  const usage = pods.reduce((sum, pod) => sum + (usageByPod.get(pod) ?? 0), 0)
  const allCapped = pods.every(pod => (limitByPod.get(pod) ?? 0) > 0)
  const limit = allCapped ? pods.reduce((sum, pod) => sum + (limitByPod.get(pod) ?? 0), 0) : null
  return { usage, limit }
}

function sumMap(byPod: Map<string, number>): number | null {
  if (byPod.size === 0) return null
  let total = 0
  for (const value of byPod.values()) total += value
  return total
}

function pressure(metrics: PerPodMetrics): number {
  const ratio = (t: ResourceTriplet) => (t.usage !== null && t.limit !== null && t.limit > 0 ? t.usage / t.limit : 0)
  return Math.max(ratio(metrics.memory), ratio(metrics.cpu))
}

export async function fetchWorkloadMetrics(namespace: string, podNames: string[]): Promise<WorkloadMetrics | null> {
  if (podNames.length === 0) return null

  const q = workloadMetricQueries(namespace, podNames)
  const [memUsage, memLimit, memRequest, cpuUsage, cpuLimit, cpuRequest, usedRows, capacityRows, qosRows] = await Promise.all([
    queryVector(q.memUsage),
    queryVector(q.memLimit),
    queryVector(q.memRequest),
    queryVector(q.cpuUsage),
    queryVector(q.cpuLimit),
    queryVector(q.cpuRequest),
    queryVector(q.volUsed),
    queryVector(q.volCapacity),
    queryVector(q.qos),
  ])

  const memUsageByPod = byPod(memUsage)
  const memLimitByPod = byPod(memLimit)
  const memRequestByPod = byPod(memRequest)
  const cpuUsageByPod = byPod(cpuUsage)
  const cpuLimitByPod = byPod(cpuLimit)
  const cpuRequestByPod = byPod(cpuRequest)
  const qos = qosByPod(qosRows)

  const volumes = pairVolumes(usedRows, capacityRows)

  const podsWithCompute = [...new Set([...memUsageByPod.keys(), ...cpuUsageByPod.keys()])]
  const perPod: PerPodMetrics[] = podsWithCompute
    .map(pod => ({
      podName: pod,
      memory: { usage: memUsageByPod.get(pod) ?? null, limit: memLimitByPod.get(pod) ?? null, request: memRequestByPod.get(pod) ?? null },
      cpu: { usage: cpuUsageByPod.get(pod) ?? null, limit: cpuLimitByPod.get(pod) ?? null, request: cpuRequestByPod.get(pod) ?? null },
      qosClass: qos.get(pod) ?? null,
    }))
    .sort((a, b) => pressure(b) - pressure(a) || a.podName.localeCompare(b.podName))

  if (perPod.length === 0 && volumes.length === 0) return null

  const mem = aggregate(memUsageByPod, memLimitByPod)
  const cpu = aggregate(cpuUsageByPod, cpuLimitByPod)
  const singlePod = podNames.length === 1

  const counts = new Map<string, number>()
  for (const cls of qos.values()) counts.set(cls, (counts.get(cls) ?? 0) + 1)
  const qosBreakdown = [...counts.entries()]
    .map(([qosClass, count]) => ({ qosClass, count }))
    .sort((a, b) => qosRank(a.qosClass) - qosRank(b.qosClass))
  const distinctQos = [...counts.keys()]
  const qosClass = distinctQos.length === 0 ? null : distinctQos.length === 1 ? distinctQos[0] : "Mixed"

  return {
    memory: { usage: mem.usage, limit: mem.limit, request: singlePod ? sumMap(memRequestByPod) : null },
    cpu: { usage: cpu.usage, limit: cpu.limit, request: singlePod ? sumMap(cpuRequestByPod) : null },
    volumes,
    qosClass,
    qosBreakdown,
    replicaCount: podNames.length,
    perPod,
  }
}

function qosRank(qosClass: string): number {
  const i = QOS_ORDER.indexOf(qosClass.toLowerCase())
  return i === -1 ? QOS_ORDER.length : i
}
