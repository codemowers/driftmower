import type { AggRow } from "./aggregate"

export type MatrixColumn = {
  key: string
  port: number | string
  protocol: string
  total: number
  peerCount: number
}

export type MatrixRow = {
  label: string
  total: number
  byColumn: Map<string, number>
}

export type Matrix = {
  columns: MatrixColumn[]
  rows: MatrixRow[]
  maxCellCount: number
}

export function buildMatrix(...sources: AggRow[][]): Matrix {
  const rowsByLabel = new Map<string, MatrixRow>()
  const columnsByKey = new Map<string, MatrixColumn>()
  let maxCellCount = 0

  for (const source of sources) {
    for (const row of source) {
      const colKey = `${row.port}::${row.protocol}`
      let col = columnsByKey.get(colKey)
      if (!col) {
        col = { key: colKey, port: row.port, protocol: row.protocol, total: 0, peerCount: 0 }
        columnsByKey.set(colKey, col)
      }

      let r = rowsByLabel.get(row.label)
      if (!r) {
        r = { label: row.label, total: 0, byColumn: new Map() }
        rowsByLabel.set(row.label, r)
      }
      const prev = r.byColumn.get(colKey) ?? 0
      if (prev === 0) col.peerCount++
      const next = prev + row.count
      r.byColumn.set(colKey, next)
      r.total += row.count
      col.total += row.count
      if (next > maxCellCount) maxCellCount = next
    }
  }

  const columns = [...columnsByKey.values()].sort((a, b) => {
    if (b.peerCount !== a.peerCount) return b.peerCount - a.peerCount
    if (b.total !== a.total) return b.total - a.total
    return String(a.port).localeCompare(String(b.port))
  })

  const rows = [...rowsByLabel.values()].sort((a, b) => {
    if (a.label !== b.label) return a.label.localeCompare(b.label)
    return b.total - a.total
  })

  return { columns, rows, maxCellCount }
}
