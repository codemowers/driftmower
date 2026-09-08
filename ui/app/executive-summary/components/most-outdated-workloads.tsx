import Link from "next/link"
import { cn } from "@/lib/utils/cn"
import type { ImageUsage } from "@/lib/cluster/refresh-state"
import type { StatusType } from "@/lib/cluster/reports"
import { SEVERITY_ORDER } from "@/lib/cluster/styles/status-style"
import type { ReportReadiness } from "@/lib/cluster/report-readiness"

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string; label: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "major" },
  minor_behind: { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "minor" },
  patch_behind: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "patch" },
}

function worstStatus(usages: ImageUsage[]): StatusType {
  return usages.reduce<StatusType>((worst, u) => {
    const s = u.versionStatus.statusType
    return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
  }, "no_data")
}

export type OutdatedWorkloadEntry = {
  key: string
  uid: string
  kind: string
  name: string
  namespace: string
  currentTag: string
  latestTag: string | null
  statusType: StatusType
}

type Props = {
  entries: OutdatedWorkloadEntry[]
  reportId: string | null
  matchHeight?: number | null
  readiness: ReportReadiness
}

const EMPTY_TEXT: Record<ReportReadiness, string> = {
  loading: "Loading workloads…",
  "no-reports": "Nothing analysed yet.",
  unresolved: "No workload has a version to compare.",
  ready: "No data available.",
}

export default function MostOutdatedWorkloads({ entries, reportId, matchHeight, readiness }: Props) {
  return (
    <div
      className="flex flex-col rounded-xl border border-gray-200 bg-white py-5"
      style={matchHeight ? { minHeight: matchHeight } : undefined}
    >
      <p className="mb-4 px-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Top 5 Most Outdated Workloads
      </p>
      {entries.length === 0 ? (
        <p className="px-6 text-sm text-muted-foreground">{EMPTY_TEXT[readiness]}</p>
      ) : (
        <div className="flex flex-col divide-y divide-gray-100">
          {entries.map(e => {
            const style = SEVERITY_STYLE[e.statusType]
            const href = reportId
              ? `/topmost-owners/${e.uid}?report=${reportId}`
              : `/topmost-owners/${e.uid}`
            return (
              <Link
                key={e.key}
                href={href}
                className="flex items-center gap-4 px-6 py-2.5 transition-colors hover:bg-brand-bg/30"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-foreground">{e.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{e.namespace} · {e.kind}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm tabular-nums text-muted-foreground">
                  <span>{e.currentTag}</span>
                  {e.latestTag && e.latestTag !== e.currentTag && (
                    <>
                      <span>→</span>
                      <span className="text-foreground">{e.latestTag}</span>
                    </>
                  )}
                </div>
                {style ? (
                  <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", style.bg, style.text)}>
                    {style.label}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                    no data
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export { worstStatus }
