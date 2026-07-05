import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import { SEVERITY_STYLE, driftSummaryPills } from "@/lib/cluster/status-style"
import type { FocusDefinition, WorkloadEntry } from "./types"

const DISPLAY_ORDER: Record<StatusType, number> = {
  major_behind: 0,
  minor_behind: 1,
  patch_behind: 2,
  up_to_date:   3,
  ahead:        4,
  no_data:      5,
  no_version:   5,
}

const PILL_STATUSES: StatusType[] = ["up_to_date", "patch_behind", "minor_behind", "major_behind"]

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
        {drift ? (
          <span className="text-sm tabular-nums text-foreground">{drift.containerCount} {drift.containerCount === 1 ? "container" : "containers"}</span>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>

      <div>
        {drift ? (
          <span className={cn("text-sm tabular-nums font-medium", staleColor(drift.staleRepoCount, drift.distinctRepoCount))}>
            {drift.staleRepoCount}/{drift.distinctRepoCount}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>

      <div className="flex items-center">
        {style ? (
          <span className={cn("text-center rounded-md px-3 py-1.5 text-xs font-semibold", style.bg, style.text)}>
            {style.label}
          </span>
        ) : (
          <span className="text-center rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            No data
          </span>
        )}
      </div>
    </>
  )
}

export const DRIFT_FOCUS: FocusDefinition = {
  key: "drift",
  label: "Drift",
  scale: [
    { token: "ok",     label: "OK",      match: e => e.worstStatus === "up_to_date" },
    { token: "patch",  label: "Patch",   match: e => e.worstStatus === "patch_behind" },
    { token: "minor",  label: "Minor",   match: e => e.worstStatus === "minor_behind" },
    { token: "major",  label: "Major",   match: e => e.worstStatus === "major_behind" },
    { token: "nodata", label: "No data", match: e => e.worstStatus === "no_data" || e.worstStatus === "no_version" },
  ],
  secondary: entries => ({
    label: "containers",
    count: entries.reduce((sum, e) => sum + (e.drift?.containerCount ?? 0), 0),
  }),
  pills: entries => driftSummaryPills(
    Object.fromEntries(
      PILL_STATUSES.map(s => [s, entries.filter(e => e.worstStatus === s).length]),
    ) as Partial<Record<StatusType, number>>,
    entries.filter(e => e.worstStatus === "no_data" || e.worstStatus === "no_version").length,
  ),
  headers: ["Contents", "Stale repos", "Drift"],
  gridCols: "grid-cols-[95px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)]",
  renderCells: entry => <DriftCells entry={entry} />,
  compare: (a, b) => DISPLAY_ORDER[a.worstStatus] - DISPLAY_ORDER[b.worstStatus],
}
