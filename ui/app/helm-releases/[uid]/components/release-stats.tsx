import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import CopyButton from "@/app/components/copy-button"

type Props = {
  normalizedScore: number
  staleRepoCount: number
  distinctRepoCount: number
  totalContainers: number
  totalWorkloadCount: number
  namespace: string
  worstStatus: StatusType
}

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string; label: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind:  { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind:  { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:    { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
}

function staleText(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}

function isNoData(status: StatusType): boolean {
  return status === "no_data" || status === "no_version"
}

export default function ReleaseStats({
  normalizedScore,
  staleRepoCount,
  distinctRepoCount,
  totalContainers,
  totalWorkloadCount,
  namespace,
  worstStatus,
}: Props) {
  const worstStyle = SEVERITY_STYLE[worstStatus]
  const workloadLabel = totalWorkloadCount === 1 ? "1 workload" : `${totalWorkloadCount} workloads`

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
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stale Repos</p>
          <p className={cn("text-xl font-semibold tabular-nums mt-0.5", staleText(staleRepoCount, distinctRepoCount))}>
            {staleRepoCount} / {distinctRepoCount}
          </p>
          <p className="text-xs text-muted-foreground">image repositories</p>
        </div>

        <div className="flex flex-col gap-1.5 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Containers</p>
          <p className="text-xl font-semibold tabular-nums text-foreground mt-0.5">{totalContainers}</p>
          <p className="text-xs text-muted-foreground">across {workloadLabel}</p>
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
