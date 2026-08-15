import DriftSparkline from "@/app/components/drift-history/drift-sparkline"
import { dayLabel, percentLabel } from "@/lib/cluster/drift-history/format"
import { isGreen, trendBetween } from "@/lib/cluster/drift-history/stats"
import { cn } from "@/lib/utils/cn"
import type { FocusDefinition, WorkloadEntry } from "./types"

function greenRatio(entry: WorkloadEntry): number | null {
  return entry.history?.stats.greenRatio ?? null
}

type Bucket = "steady" | "improving" | "regressing" | "chronic" | "none"

function bucketOf(entry: WorkloadEntry): Bucket {
  const stats = entry.history?.stats
  if (!stats || stats.greenRatio === null) return "none"

  const trend = trendBetween(stats.startStatus, stats.currentStatus)
  if (trend === "regressed") return "regressing"
  if (trend === "improved") return "improving"
  return isGreen(stats.currentStatus) ? "steady" : "chronic"
}

function inBucket(bucket: Bucket): (entry: WorkloadEntry) => boolean {
  return entry => bucketOf(entry) === bucket
}

function greenText(ratio: number | null): string {
  if (ratio === null) return "text-muted-foreground"
  if (ratio >= 0.8) return "text-status-ok-label"
  if (ratio >= 0.5) return "text-status-minor-label"
  return "text-status-major-label"
}

function HistoryCells({ entry }: { entry: WorkloadEntry }) {
  const history = entry.history

  if (!history) {
    return (
      <>
        <div><span className="text-sm text-muted-foreground">—</span></div>
        <div><span className="text-sm text-muted-foreground">—</span></div>
        <div><span className="text-sm text-muted-foreground">—</span></div>
      </>
    )
  }

  const ratio = history.stats.greenRatio
  const lastDeploy = history.stats.lastDeployAt

  return (
    <>
      <div className="flex items-center">
        <DriftSparkline spans={history.spans} className="w-full max-w-40" />
      </div>
      <div>
        <span className={cn("text-sm font-semibold tabular-nums", greenText(ratio))}>{percentLabel(ratio)}</span>
      </div>
      <div>
        <span className="font-mono text-xs text-muted-foreground">
          {lastDeploy === null ? "unknown" : dayLabel(lastDeploy)}
        </span>
      </div>
    </>
  )
}

export const HISTORY_FOCUS: FocusDefinition = {
  key: "history",
  label: "History",
  scale: [
    { token: "steady",     label: "Steady",     match: inBucket("steady") },
    { token: "improving",  label: "Improving",  match: inBucket("improving") },
    { token: "regressing", label: "Regressing", match: inBucket("regressing") },
    { token: "chronic",    label: "Chronic",    match: inBucket("chronic") },
    { token: "nohistory",  label: "No history", match: inBucket("none") },
  ],
  secondary: entries => ({
    label: "tracked",
    count: entries.filter(e => bucketOf(e) !== "none").length,
  }),
  pills: entries => {
    const counts: Record<Bucket, number> = { steady: 0, improving: 0, regressing: 0, chronic: 0, none: 0 }
    for (const entry of entries) counts[bucketOf(entry)] += 1
    return [
      { label: "Steady",     count: counts.steady,     bg: "bg-status-ok-bg",      text: "text-status-ok-label" },
      { label: "Improving",  count: counts.improving,  bg: "bg-status-patch-bg",   text: "text-status-patch-label" },
      { label: "Regressing", count: counts.regressing, bg: "bg-status-minor-bg",   text: "text-status-minor-label" },
      { label: "Chronic",    count: counts.chronic,    bg: "bg-status-major-bg",   text: "text-status-major-label" },
      ...(counts.none > 0
        ? [{ label: "No history", count: counts.none, bg: "bg-status-neutral-bg", text: "text-status-neutral-label" }]
        : []),
    ]
  },
  headers: ["Historic drift", "Green", "Last deploy"],
  gridCols: "grid-cols-[95px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1fr)_80px_minmax(0,1fr)]",
  renderCells: entry => <HistoryCells entry={entry} />,
  compare: (a, b) => {
    const left = greenRatio(a)
    const right = greenRatio(b)
    if (left === null && right === null) return a.name.localeCompare(b.name)
    if (left === null) return 1
    if (right === null) return -1
    return left - right || a.name.localeCompare(b.name)
  },
}
