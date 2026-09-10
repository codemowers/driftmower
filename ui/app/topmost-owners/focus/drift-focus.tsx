import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import { DISPLAY_ORDER, DRIFT_PILL_STATUSES, SEVERITY_STYLE, driftSummaryPills, isNoData } from "@/lib/cluster/styles/status-style"
import type { FocusDefinition, WorkloadEntry } from "./types"

function staleColor(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-muted-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}

function DriftCells({ entry }: { entry: WorkloadEntry }) {
  const { drift, worstStatus } = entry
  const style = SEVERITY_STYLE[worstStatus]

  return (
    <>
      <div>
        <span className="text-sm tabular-nums text-foreground">
          {drift.containerCount} {drift.containerCount === 1 ? "container" : "containers"}
        </span>
      </div>

      <div>
        <span className={cn("text-sm tabular-nums font-medium", staleColor(drift.staleRepoCount, drift.distinctRepoCount))}>
          {drift.staleRepoCount}/{drift.distinctRepoCount}
        </span>
      </div>

      <div className="flex items-center">
        <span className={cn("text-center rounded-md px-3 py-1.5 text-xs font-semibold", style.bg, style.text)}>
          {style.label}
        </span>
      </div>
    </>
  )
}

export const DRIFT_FOCUS: FocusDefinition = {
  key: "drift",
  label: "Drift",
  scale: [
    { token: "ahead",  label: "Ahead",   match: e => e.worstStatus === "ahead" },
    { token: "ok",     label: "OK",      match: e => e.worstStatus === "up_to_date" },
    { token: "patch",  label: "Patch",   match: e => e.worstStatus === "patch_behind" },
    { token: "minor",  label: "Minor",   match: e => e.worstStatus === "minor_behind" },
    { token: "major",  label: "Major",   match: e => e.worstStatus === "major_behind" },
    { token: "nodata", label: "No data", match: e => isNoData(e.worstStatus) },
  ],
  secondary: entries => ({
    label: "containers",
    count: entries.reduce((sum, e) => sum + e.drift.containerCount, 0),
  }),
  pills: entries => driftSummaryPills(
    Object.fromEntries(
      DRIFT_PILL_STATUSES.map(s => [s, entries.filter(e => e.worstStatus === s).length]),
    ) as Partial<Record<StatusType, number>>,
    entries.filter(e => isNoData(e.worstStatus)).length,
  ),
  headers: ["Contents", "Stale repos", "Drift"],
  gridCols: "grid-cols-[95px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)]",
  renderCells: entry => <DriftCells entry={entry} />,
  compare: (a, b) => DISPLAY_ORDER[a.worstStatus] - DISPLAY_ORDER[b.worstStatus],
}
