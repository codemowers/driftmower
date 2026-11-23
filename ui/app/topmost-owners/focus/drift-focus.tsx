import { cn } from "@/lib/utils/cn"
import { ISSUE_SEVERITIES, ISSUE_STYLE, issueRank } from "@/lib/cluster/issues"
import type { FocusDefinition, WorkloadEntry } from "./types"

function IssueCells({ entry }: { entry: WorkloadEntry }) {
  const { score, worst } = issueRank(entry.issues ?? [])
  const style = worst ? ISSUE_STYLE[worst] : undefined
  return <>
    <span className="text-sm tabular-nums text-foreground">{entry.drift.containerCount} {entry.drift.containerCount === 1 ? "container" : "containers"}</span>
    <div>
      <span title="Weighted issue rank: critical 27, warning 9, notice 3, info 1; repeated issue kinds add logarithmically. This is a presentation rank, not a security assessment."
        className={cn("rounded-md px-3 py-1.5 text-xs font-semibold tabular-nums", style?.bg ?? "bg-status-neutral-bg", style?.text ?? "text-status-neutral-label")}>
        {score ? `${score} · ${worst}` : "No reported issues"}
      </span>
      {(entry.worstStatus === "no_data" || entry.worstStatus === "no_version") && <p className="mt-1 text-xs text-muted-foreground">Version data unavailable</p>}
    </div>
  </>
}

export const DRIFT_FOCUS: FocusDefinition = {
  key: "drift",
  label: "Issues",
  scale: [],
  secondary: entries => ({ label: "containers", count: entries.reduce((sum, e) => sum + e.drift.containerCount, 0) }),
  pills: entries => ISSUE_SEVERITIES.map(severity => ({
    label: severity,
    count: entries.filter(e => issueRank(e.issues ?? []).worst === severity).length,
    ...ISSUE_STYLE[severity],
  })),
  headers: ["Contents", "Issue rank"],
  gridCols: "grid-cols-[95px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)]",
  renderCells: entry => <IssueCells entry={entry} />,
  compare: (a, b) => issueRank(b.issues ?? []).score - issueRank(a.issues ?? []).score || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
}
