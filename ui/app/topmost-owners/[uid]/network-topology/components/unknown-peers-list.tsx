import { cn } from "@/lib/utils/cn"
import type { AggRow } from "@/lib/features/netstatd"

type Props = {
  rows: AggRow[]
}

export default function UnknownPeersList({ rows }: Props) {
  return (
    <ul className="divide-y divide-gray-100">
      {rows.map(row => (
        <li
          key={row.key}
          className="flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-gray-50"
        >
          <span className="truncate font-mono text-sm text-foreground">{row.label}</span>
          <span className="font-mono text-xs text-muted-foreground">
            :{row.port} {row.protocol}
          </span>
          <span
            className={cn(
              "ml-auto shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted-foreground",
              row.count >= 10 && "bg-brand-bg text-brand-label",
            )}
          >
            ×{row.count}
          </span>
        </li>
      ))}
    </ul>
  )
}
