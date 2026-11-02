import { fetchJson } from "@/lib/utils/fetch-json"
import type { PromQuery, VectorRow } from "./query"

export type NodeStorageMap = Record<string, { used: number; total: number }>

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

export function fetchNodeStorage(): Promise<NodeStorageMap> {
  return fetchJson<NodeStorageMap>("/api/prometheus/node-storage")
}

export async function loadNodeStorage(prom: PromQuery): Promise<NodeStorageMap> {
  const [sizeRows, availRows] = await Promise.all([
    prom.vector("topolvm_volumegroup_size_bytes"),
    prom.vector("topolvm_volumegroup_available_bytes"),
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
