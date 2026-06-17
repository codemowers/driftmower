import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"

const CHIPS: { status: StatusType; label: string; bg: string; text: string }[] = [
  { status: "up_to_date",   label: "OK",    bg: "bg-status-ok-bg",    text: "text-status-ok-label" },
  { status: "patch_behind", label: "Patch", bg: "bg-status-patch-bg", text: "text-status-patch-label" },
  { status: "minor_behind", label: "Minor", bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  { status: "major_behind", label: "Major", bg: "bg-status-major-bg", text: "text-status-major-label" },
]

type Props = {
  totalLabel: string
  totalCount: number
  secondaryLabel?: string
  secondaryCount?: number
  statusCounts: Partial<Record<StatusType, number>>
  noDataCount?: number
}

export default function StatusSummaryBar({ totalLabel, totalCount, secondaryLabel, secondaryCount, statusCounts, noDataCount }: Props) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-3.5">
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground tabular-nums">{totalCount}</span> {totalLabel}</span>
        {secondaryLabel !== undefined && secondaryCount !== undefined && (
          <>
            <span className="text-gray-200">|</span>
            <span><span className="font-semibold text-foreground tabular-nums">{secondaryCount}</span> {secondaryLabel}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {CHIPS.map(({ status, label, bg, text }) => {
          const count = statusCounts[status] ?? 0
          return (
            <span key={status} className={cn("rounded-md px-3 py-1.5 text-xs font-semibold tabular-nums", bg, text)}>
              {label} {count}
            </span>
          )
        })}
        {(noDataCount ?? 0) > 0 && (
          <span className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold tabular-nums text-muted-foreground">
            No data {noDataCount}
          </span>
        )}
      </div>
    </div>
  )
}
