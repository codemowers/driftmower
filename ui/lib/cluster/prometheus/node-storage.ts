export type NodeStorageMap = Record<string, { used: number; total: number }>

type VectorRow = { metric: Record<string, string>; value: [number, string] }

async function queryVector(promql: string): Promise<VectorRow[]> {
  const res = await fetch(`/api/prometheus/query?query=${encodeURIComponent(promql)}`, { cache: "no-store" })
  if (!res.ok) return []
  const json = await res.json() as { data?: { result?: VectorRow[] } }
  return json.data?.result ?? []
}

function sumByNode(rows: VectorRow[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const row of rows) {
    const node = row.metric.node
    if (!node) continue
    const val = Number(row.value[1])
    if (Number.isFinite(val)) map[node] = (map[node] ?? 0) + val
  }
  return map
}

export async function fetchNodeStorage(): Promise<NodeStorageMap> {
  const [sizeRows, availRows] = await Promise.all([
    queryVector("topolvm_volumegroup_size_bytes"),
    queryVector("topolvm_volumegroup_available_bytes"),
  ])

  const sizeByNode = sumByNode(sizeRows)
  const availByNode = sumByNode(availRows)

  const result: NodeStorageMap = {}
  for (const node of Object.keys(sizeByNode)) {
    const total = sizeByNode[node]
    const avail = availByNode[node] ?? 0
    result[node] = { total, used: total - avail }
  }
  return result
}
