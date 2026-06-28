import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import { SEVERITY_STYLE, isNoData } from "@/lib/cluster/status-style"
import CopyButton from "@/app/components/copy-button"

// Shared building blocks for the resource stats cards (release / workload / pod).
// All three are a 4-column grid; the Drift Score and Namespace cells are
// identical, the middle two cells vary per resource.

const CELL_LABEL = "text-xs font-semibold uppercase tracking-wider text-muted-foreground"

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="grid grid-cols-4 divide-x divide-gray-200">{children}</div>
    </div>
  )
}

export function StatCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5">
      <p className={CELL_LABEL}>{label}</p>
      {children}
    </div>
  )
}

export function StatValue({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xl font-semibold tabular-nums text-foreground mt-0.5", className)}>{children}</p>
}

export function StatCaption({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

export function DriftScoreCell({
  worstStatus,
  normalizedScore,
}: {
  worstStatus: StatusType
  normalizedScore: number
}) {
  return (
    <StatCell label="Drift Score">
      {isNoData(worstStatus)
        ? <p className="text-xl font-medium text-foreground mt-0.5">no data</p>
        : <StatValue>{normalizedScore.toFixed(2)}</StatValue>}
      <StatCaption>0 = healthy · 1 = outdated</StatCaption>
    </StatCell>
  )
}

export function NamespaceCell({
  namespace,
  worstStatus,
}: {
  namespace: string
  worstStatus: StatusType
}) {
  const worstStyle = SEVERITY_STYLE[worstStatus]
  return (
    <div className="flex flex-col gap-2 px-6 py-5">
      <p className={CELL_LABEL}>Namespace</p>
      <div className="flex items-center gap-1.5">
        <p className="font-mono text-md font-semibold text-foreground">{namespace}</p>
        <CopyButton value={namespace} />
      </div>
      <div className="flex items-center gap-1">
        <p className="text-xs text-muted-foreground">Worst:</p>
        {worstStyle ? (
          <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", worstStyle.bg, worstStyle.text)}>
            {worstStyle.label}
          </span>
        ) : (
          <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-muted-foreground">
            No data
          </span>
        )}
      </div>
    </div>
  )
}
