import { cn } from "@/lib/utils"
import type { StatusType } from "@/lib/cluster/reports"
import CopyButton from "@/app/components/copy-button"

type Props = {
  phase: string
  nodeName: string
  totalContainers: number
  staleContainerCount: number
  namespace: string
  worstStatus: StatusType
  normalizedScore: number
}

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string; label: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

function isNoData(status: StatusType): boolean {
  return status === "no_data" || status === "no_version"
}

export default function PodStats({
  phase,
  nodeName,
  totalContainers,
  staleContainerCount,
  namespace,
  worstStatus,
  normalizedScore,
}: Props) {
  const worstStyle = SEVERITY_STYLE[worstStatus]
  const staleLabel =
    totalContainers === 0
      ? "—"
      : staleContainerCount === 0
        ? "all up to date"
        : `${staleContainerCount} stale`

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="grid grid-cols-4 divide-x divide-gray-200">
        <div className="flex flex-col gap-1.5 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drift Score</p>
          {isNoData(worstStatus)
            ? <p className="text-xl font-medium text-foreground mt-0.5">no data</p>
            : <p className="text-xl font-semibold tabular-nums text-foreground mt-0.5">{normalizedScore.toFixed(2)}</p>
          }
          <p className="text-xs text-muted-foreground">0 = healthy · 1 = outdated</p>
        </div>

        <div className="flex flex-col gap-1.5 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phase</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={cn("size-2 rounded-full", PHASE_DOT[phase] ?? "bg-gray-400")} />
            <p className="text-xl font-semibold text-foreground">{phase}</p>
          </div>
          <p className="font-mono text-xs text-muted-foreground truncate" title={nodeName}>
            {nodeName}
          </p>
        </div>

        <div className="flex flex-col gap-1.5 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Containers</p>
          <p className="text-xl font-semibold tabular-nums text-foreground mt-0.5">{totalContainers}</p>
          <p className="text-xs text-muted-foreground">{staleLabel}</p>
        </div>

        <div className="flex flex-col gap-2 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Namespace</p>
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
      </div>
    </div>
  )
}
