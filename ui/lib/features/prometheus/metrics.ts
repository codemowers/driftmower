
export type ClusterMetrics = {
  storage: { used: number; total: number } | null
  memory: { total: number; used: number; buffers: number; cached: number } | null
  cpu: { used: number; capacity: number } | null
  io?: ClusterIO | null
  // MinIO buckets across the cluster: summed quotas and usage.
  buckets?: { count: number; requests: number | null; usage: number | null } | null
  // PromQL graphs of each total beside its capacity, by storage, memory and cpu.
  graphs?: Record<string, string[]>
}

export type IORates = { networkRx: number | null; networkTx: number | null; diskRead: number | null; diskWrite: number | null }
export type ClusterIO = IORates & { nodes: (IORates & { node: string })[]; warnings: string[] }
