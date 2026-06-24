export type ResourceTriplet = {
  usage: number | null
  limit: number | null
  request: number | null
}

export type PodVolume = {
  name: string
  used: number
  capacity: number
}

export type PodMetrics = {
  memory: ResourceTriplet
  cpu: ResourceTriplet
  volumes: PodVolume[]
  qosClass: string | null
}

type VectorRow = { metric: Record<string, string>; value: [number, string] }

export function podMetricQueries(namespace: string, pod: string) {
  const sel = `namespace="${namespace}",pod="${pod}"`
  const pvcInfo = `kube_pod_spec_volumes_persistentvolumeclaims_info{${sel}}`
  return {
    memUsage: `sum(container_memory_working_set_bytes{${sel},container!=""})`,
    memLimit: `sum(kube_pod_container_resource_limits{${sel},resource="memory"})`,
    memRequest: `sum(kube_pod_container_resource_requests{${sel},resource="memory"})`,
    cpuUsage: `sum(rate(container_cpu_usage_seconds_total{${sel},container!=""}[5m]))`,
    cpuLimit: `sum(kube_pod_container_resource_limits{${sel},resource="cpu"})`,
    cpuRequest: `sum(kube_pod_container_resource_requests{${sel},resource="cpu"})`,
    volUsed: `kubelet_volume_stats_used_bytes and on(namespace,persistentvolumeclaim) ${pvcInfo}`,
    volCapacity: `kubelet_volume_stats_capacity_bytes and on(namespace,persistentvolumeclaim) ${pvcInfo}`,
    qos: `kube_pod_status_qos_class{${sel}}`,
  }
}

async function queryScalar(promql: string): Promise<number | null> {
  const res = await fetch(`/api/prometheus/query?query=${encodeURIComponent(promql)}`, { cache: "no-store" })
  if (!res.ok) return null
  const json = await res.json() as { data?: { result?: { value?: [number, string] }[] } }
  const raw = json.data?.result?.[0]?.value?.[1]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

async function queryVector(promql: string): Promise<VectorRow[]> {
  const res = await fetch(`/api/prometheus/query?query=${encodeURIComponent(promql)}`, { cache: "no-store" })
  if (!res.ok) return []
  const json = await res.json() as { data?: { result?: VectorRow[] } }
  return json.data?.result ?? []
}

function pairVolumes(usedRows: VectorRow[], capacityRows: VectorRow[]): PodVolume[] {
  const capacityByPvc = new Map<string, number>()
  for (const row of capacityRows) {
    const pvc = row.metric.persistentvolumeclaim
    const value = Number(row.value[1])
    if (pvc && Number.isFinite(value)) capacityByPvc.set(pvc, value)
  }

  const volumes: PodVolume[] = []
  for (const row of usedRows) {
    const pvc = row.metric.persistentvolumeclaim
    if (!pvc) continue
    const used = Number(row.value[1])
    const capacity = capacityByPvc.get(pvc)
    if (!Number.isFinite(used) || capacity === undefined) continue
    volumes.push({ name: pvc, used, capacity })
  }

  return volumes.sort((a, b) => fullness(b) - fullness(a))
}

function fullness(volume: PodVolume): number {
  return volume.capacity > 0 ? volume.used / volume.capacity : 0
}

export async function fetchPodMetrics(namespace: string, pod: string): Promise<PodMetrics | null> {
  const q = podMetricQueries(namespace, pod)
  const [memUsage, memLimit, memRequest, cpuUsage, cpuLimit, cpuRequest, usedRows, capacityRows, qosRows] = await Promise.all([
    queryScalar(q.memUsage),
    queryScalar(q.memLimit),
    queryScalar(q.memRequest),
    queryScalar(q.cpuUsage),
    queryScalar(q.cpuLimit),
    queryScalar(q.cpuRequest),
    queryVector(q.volUsed),
    queryVector(q.volCapacity),
    queryVector(q.qos),
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
