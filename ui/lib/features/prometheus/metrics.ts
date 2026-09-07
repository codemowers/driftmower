import { queryScalar } from "./query"

export type ClusterMetrics = {
  storage: { used: number; total: number } | null
  memory: { total: number; used: number; buffers: number; cached: number } | null
  cpuLoad: number | null
}

export async function fetchClusterMetrics(): Promise<ClusterMetrics> {
  const [storageTotal, storageUsed, memTotal, memFree, memBuffers, memCached, cpuLoad] = await Promise.all([
    queryScalar("sum(topolvm_volumegroup_size_bytes)"),
    queryScalar("sum(topolvm_volumegroup_size_bytes - topolvm_volumegroup_available_bytes)"),
    queryScalar("sum(node_memory_MemTotal_bytes)"),
    queryScalar("sum(node_memory_MemFree_bytes)"),
    queryScalar("sum(node_memory_Buffers_bytes)"),
    queryScalar("sum(node_memory_Cached_bytes)"),
    queryScalar("sum(node_load1) / count(count by (cpu, instance)(node_cpu_seconds_total))"),
  ])

  return {
    storage: storageTotal !== null && storageUsed !== null
      ? { used: storageUsed, total: storageTotal }
      : null,
    memory: memTotal !== null && memFree !== null && memBuffers !== null && memCached !== null
      ? {
          total: memTotal,
          used: Math.max(memTotal - memFree - memBuffers - memCached, 0),
          buffers: memBuffers,
          cached: memCached,
        }
      : null,
    cpuLoad: cpuLoad !== null ? cpuLoad : null,
  }
}
