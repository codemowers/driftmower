import { cn } from "@/lib/utils/cn"
import type { Matrix } from "@/lib/features/netstatd"

type Props = {
  matrix: Matrix
}

export default function PortMatrix({ matrix }: Props) {
  const { columns, rows, maxCellCount } = matrix

  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <p className="text-sm text-muted-foreground">No outbound traffic to display.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-20 border-b border-r border-gray-200 bg-gray-50 px-3 py-2 text-left text-[10px] uppercase tracking-wider text-muted-foreground shadow-[inset_-8px_0_8px_-8px_rgba(0,0,0,0.06)]"
            >
              peer
            </th>
            {columns.map(col => (
              <th
                key={col.key}
                scope="col"
                className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 px-3 py-2 text-right text-muted-foreground"
                title={`${col.peerCount} ${col.peerCount === 1 ? "peer" : "peers"} · ${col.total} total`}
              >
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-foreground">:{col.port}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {col.protocol}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label} className="group">
              <th
                scope="row"
                className="sticky left-0 z-10 truncate border-b border-r border-gray-100 bg-white px-3 py-2 text-left text-sm font-normal text-foreground shadow-[inset_-8px_0_8px_-8px_rgba(0,0,0,0.06)] group-hover:bg-gray-50"
              >
                {row.label}
              </th>
              {columns.map(col => {
                const count = row.byColumn.get(col.key) ?? 0
                return (
                  <td
                    key={col.key}
                    className={cn(
                      "border-b border-gray-100 px-3 py-2 text-right tabular-nums",
                      count === 0 ? "text-muted-foreground/30" : "text-foreground",
                      count > 0 && cellShade(count, maxCellCount),
                    )}
                  >
                    {count === 0 ? "—" : count}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function cellShade(count: number, max: number): string {
  if (max <= 0) return ""
  const ratio = count / max
  if (ratio >= 0.66) return "bg-brand-bg/80"
  if (ratio >= 0.33) return "bg-brand-bg/50"
  return "bg-brand-bg/25"
}
