import { cn } from "@/lib/utils"
import type { ImageUsage } from "@/lib/cluster/refresh-state"

type StatusType = ImageUsage["versionStatus"]["statusType"]

const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 4,
  minor_behind:  3,
  patch_behind:  2,
  up_to_date:    1,
  ahead:         0,
  no_data:      -1,
  no_version:   -1,
}

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
  kind: string
  name: string
  namespace: string
  currentTag: string
  latestTag: string | null
  statusType: StatusType
}

type Props = { entries: OutdatedWorkloadEntry[] }

export default function MostOutdatedWorkloads({ entries }: Props) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Top 5 Most Outdated Workloads
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data available.</p>
      ) : (
        <div className="flex flex-col divide-y divide-gray-100">
          {entries.map(e => {
            const style = SEVERITY_STYLE[e.statusType]
            return (
              <div key={e.key} className="flex items-center gap-4 py-2.5">
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export { worstStatus }
