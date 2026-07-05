import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"
import type { SummaryPill } from "@/lib/cluster/status-style"

type Props = {
  totalLabel: string
  totalCount: number
  secondary?: { label: string; count: number }
  pills: SummaryPill[]
  leading?: ReactNode
}

export default function StatusSummaryBar({ totalLabel, totalCount, secondary, pills, leading }: Props) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-3.5">
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        {leading}
        {leading && <span className="text-gray-200">|</span>}
        <span><span className="font-semibold text-foreground tabular-nums">{totalCount}</span> {totalLabel}</span>
        {secondary && (
          <>
            <span className="text-gray-200">|</span>
            <span><span className="font-semibold text-foreground tabular-nums">{secondary.count}</span> {secondary.label}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {pills.map(pill => (
          <span key={pill.label} className={cn("rounded-md px-3 py-1.5 text-xs font-semibold tabular-nums", pill.bg, pill.text)}>
            {pill.label} {pill.count}
          </span>
        ))}
      </div>
    </div>
  )
}
