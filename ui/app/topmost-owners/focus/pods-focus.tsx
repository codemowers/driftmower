import { cn } from "@/lib/utils/cn"
import { POD_SEVERITY_STYLE, POD_SORT_ORDER, type PodSeverity } from "@/lib/cluster/pod-status-style"
import PodStatusSquares from "../components/pod-status-squares"
import type { FocusDefinition, WorkloadEntry } from "./types"

const PILL_LEVELS: { severity: PodSeverity; always: boolean }[] = [
  { severity: "healthy",   always: true },
  { severity: "pending",   always: true },
  { severity: "unknown",   always: false },
  { severity: "failed",    always: true },
  { severity: "succeeded", always: false },
]

function stateIs(severity: PodSeverity) {
  return (e: WorkloadEntry) => (e.pods?.total ?? 0) > 0 && e.pods?.worst.severity === severity
}

function PodsCells({ entry }: { entry: WorkloadEntry }) {
  const pods = entry.pods

  if (!pods || pods.total === 0) {
    return (
      <>
        <div>
          <span className="text-sm tabular-nums text-muted-foreground">{pods ? "0 pods" : "—"}</span>
        </div>
        <div>
          <span className="text-sm text-muted-foreground">—</span>
        </div>
        <div className="flex items-center">
          {pods ? (
            <span className="text-center rounded-md bg-status-neutral-bg px-3 py-1.5 text-xs font-semibold text-status-neutral-label">
              No pods
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

  const worstStyle = POD_SEVERITY_STYLE[pods.worst.severity]

  return (
    <>
      <div>
        <span className="text-sm tabular-nums text-foreground">{pods.total} {pods.total === 1 ? "pod" : "pods"}</span>
      </div>

      <div className="flex items-center">
        <PodStatusSquares counts={pods.counts} />
      </div>

      <div className="flex min-w-0 items-center">
        <span
          title={pods.worst.display}
          className={cn("max-w-full truncate rounded-md px-3 py-1.5 text-center text-xs font-semibold", worstStyle.bg, worstStyle.text)}
        >
          {pods.worst.display}
        </span>
      </div>
    </>
  )
}

export const PODS_FOCUS: FocusDefinition = {
  key: "pods",
  label: "Pods",
  scale: [
    { token: "healthy",   label: "Healthy",   match: stateIs("healthy") },
    { token: "pending",   label: "Pending",   match: stateIs("pending") },
    { token: "unknown",   label: "Unknown",   match: stateIs("unknown") },
    { token: "failed",    label: "Failed",    match: stateIs("failed") },
    { token: "completed", label: "Completed", match: stateIs("succeeded") },
  ],
  secondary: entries => ({
    label: "pods",
    count: entries.reduce((sum, e) => sum + (e.pods?.total ?? 0), 0),
  }),
  pills: entries => {
    const counts: Record<PodSeverity, number> = { failed: 0, unknown: 0, pending: 0, healthy: 0, succeeded: 0 }
    for (const e of entries) {
      if (!e.pods) continue
      for (const level of PILL_LEVELS) counts[level.severity] += e.pods.counts[level.severity]
    }
    return PILL_LEVELS
      .filter(({ severity, always }) => always || counts[severity] > 0)
      .map(({ severity }) => {
        const style = POD_SEVERITY_STYLE[severity]
        return { label: style.label, count: counts[severity], bg: style.bg, text: style.text }
      })
  },
  headers: ["Contents", "Status", "State"],
  gridCols: "grid-cols-[95px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,0.7fr)_110px_minmax(0,1.6fr)]",
  renderCells: entry => <PodsCells entry={entry} />,
  compare: (a, b) => {
    for (const severity of POD_SORT_ORDER) {
      const diff = (b.pods?.counts[severity] ?? 0) - (a.pods?.counts[severity] ?? 0)
      if (diff !== 0) return diff
    }
    const groupDiff = livenessGroup(a.pods) - livenessGroup(b.pods)
    if (groupDiff !== 0) return groupDiff
    const succeededDiff = (b.pods?.counts.succeeded ?? 0) - (a.pods?.counts.succeeded ?? 0)
    if (succeededDiff !== 0) return succeededDiff
    return a.name.localeCompare(b.name)
  },
}

function livenessGroup(pods: WorkloadEntry["pods"]): number {
  if (!pods || pods.total === 0) return 3
  if (pods.counts.succeeded > 0) return pods.counts.healthy > 0 ? 1 : 0
  return 2
}
