export type ClusterMetrics = {
  storage: { used: number; total: number } | null
  memory: { cached: number; total: number } | null
  pods: { running: number; total: number; pending: number } | null
  cpuLoad: number | null
}

async function queryScalar(promql: string): Promise<number | null> {
  const res = await fetch(`/api/prometheus/query?query=${encodeURIComponent(promql)}`, { cache: "no-store" })
  if (!res.ok) return null
  const json = await res.json() as { data?: { result?: { value?: [number, string] }[] } }
  const raw = json.data?.result?.[0]?.value?.[1]
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export async function fetchClusterMetrics(): Promise<ClusterMetrics> {
  const [storageTotal, storageUsed, memoryTotal, memoryCached, podsRunning, podsTotal, podsPending, cpuLoad] = await Promise.all([
    queryScalar("sum(topolvm_volumegroup_size_bytes)"),
    queryScalar("sum(topolvm_volumegroup_size_bytes - topolvm_volumegroup_available_bytes)"),
    queryScalar("sum(node_memory_MemTotal_bytes)"),
    queryScalar("sum(node_memory_Cached_bytes)"),
    queryScalar('sum(kube_pod_status_phase{phase="Running"})'),
    queryScalar("sum(kube_pod_status_phase)"),
    queryScalar('sum(kube_pod_status_phase{phase="Pending"})'),
    queryScalar("sum(node_load1) / count(count by (cpu, instance)(node_cpu_seconds_total))"),
  ])

  return {
    storage: storageTotal !== null && storageUsed !== null
      ? { used: storageUsed, total: storageTotal }
      : null,
    memory: memoryTotal !== null && memoryCached !== null
      ? { cached: memoryCached, total: memoryTotal }
      : null,
    pods: podsRunning !== null && podsTotal !== null
      ? { running: Math.round(podsRunning), total: Math.round(podsTotal), pending: Math.round(podsPending ?? 0) }
      : null,
    cpuLoad: cpuLoad !== null ? cpuLoad : null,
  }
}
