import { fetchJson } from "@/lib/utils/fetch-json"
import type { PromQuery } from "./query"

export type ClusterMetrics = {
  storage: { used: number; total: number } | null
  memory: { total: number; used: number; buffers: number; cached: number } | null
  cpuLoad: number | null
}

export function fetchClusterMetrics(): Promise<ClusterMetrics> {
  return fetchJson<ClusterMetrics>("/api/prometheus/cluster-metrics")
}

export async function loadClusterMetrics(prom: PromQuery): Promise<ClusterMetrics> {
  const [storageTotal, storageUsed, memTotal, memFree, memBuffers, memCached, cpuLoad] = await Promise.all([
    prom.scalar("sum(topolvm_volumegroup_size_bytes)"),
    prom.scalar("sum(topolvm_volumegroup_size_bytes - topolvm_volumegroup_available_bytes)"),
    prom.scalar("sum(node_memory_MemTotal_bytes)"),
    prom.scalar("sum(node_memory_MemFree_bytes)"),
    prom.scalar("sum(node_memory_Buffers_bytes)"),
    prom.scalar("sum(node_memory_Cached_bytes)"),
    prom.scalar("sum(node_load1) / count(count by (cpu, instance)(node_cpu_seconds_total))"),
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
