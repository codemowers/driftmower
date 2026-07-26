"use client"

import Link from "next/link"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow } from "@/lib/utils/format-time"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import { SEVERITY_STYLE } from "@/lib/cluster/status-style"
import { CVE_SEVERITY_STYLE, worstVulnerability, type VulnerabilityReport } from "@/lib/cluster/vulnerability"
import { digestCrumb, resolvedVersion } from "@/lib/utils/image-artifacts"

function WorstCveCell({ report }: { report: VulnerabilityReport | null | undefined }) {
  if (report === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  if (report === null) {
    return (
      <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-semibold text-muted-foreground">
        No scan
      </span>
    )
  }
  const worst = worstVulnerability(report)
  if (!worst) {
    return (
      <span className="rounded-md bg-status-ok-bg px-2 py-1 text-xs font-semibold text-status-ok-label">
        Clean
      </span>
    )
  }
  const s = CVE_SEVERITY_STYLE[worst.severity]
  return (
    <span className={cn("rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap", s.bg, s.text)}>
      {s.label}{worst.score > 0 && ` ${worst.score}`}
    </span>
  )
}

function TagCell({ tag, builtAt }: { tag: string | null; builtAt?: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-sm text-foreground">{tag ?? "—"}</span>
      {builtAt && (
        <Tooltip>
          <TooltipTrigger asChild>
            <time dateTime={builtAt} className="font-mono text-xs text-muted-foreground">
              {relativeTimeFromNow(builtAt)}
            </time>
          </TooltipTrigger>
          <TooltipContent>{builtAt}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  workloadUid: string
  contextQuery: string
}

const GRID = "grid-cols-[3fr_5fr_1.5fr_1.5fr_1.5fr_1.5fr]"
const HEADERS = ["Container", "Image", "Running", "Available", "Version drift", "Worst CVE"]

export default function ImagesTab({ usages, issues, workloadUid, contextQuery }: Props) {
  const vulnReports = useClusterState(s => s.vulnerabilityReports)

  if (usages.length === 0) {
    return <p className="text-sm text-muted-foreground">No container data available.</p>
  }

  const deduped = new Map<string, { usage: ImageUsage; count: number }>()
  for (const u of usages) {
    const key = `${u.containerName}::${u.imageInfo.registry}/${u.imageInfo.repository}::${u.imageInfo.digest}`
    const existing = deduped.get(key)
    if (existing) existing.count++
    else deduped.set(key, { usage: u, count: 1 })
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <div className={cn("grid gap-4 border-b border-gray-100 bg-gray-50 px-4 py-3", GRID)}>
        {HEADERS.map(h => (
          <p key={h} className="text-xs font-medium text-muted-foreground">{h}</p>
        ))}
      </div>

      <div>
        {Array.from(deduped.values()).map(({ usage: u, count }, idx) => {
          const vs = u.versionStatus
          const statusStyle = SEVERITY_STYLE[vs.statusType]
          const issue = issues.find(i => u.image.includes(i.image))
          const vulnReport = vulnReports === null ? undefined : vulnReports[u.imageInfo.digest] ?? null

          return (
            <div
              key={`${u.containerName}::${u.image}::${u.imageInfo.digest}`}
              className={cn(idx > 0 && "border-t border-gray-100")}
            >
              <div className={cn("grid items-center gap-4 px-4 py-3", GRID)}>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-sm font-medium text-foreground">
                    {u.containerName}
                  </span>
                  {count > 1 && (
                    <span className="shrink-0 rounded bg-gray-100 px-1 text-xs text-muted-foreground">
                      ×{count}
                    </span>
                  )}
                </div>
                <Link
                  href={`/topmost-owners/${workloadUid}/images/${encodeURIComponent(u.imageInfo.digest)}${contextQuery}`}
                  className="group flex min-w-0 flex-col font-mono text-xs text-muted-foreground hover:text-brand-text hover:underline"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{u.imageInfo.registry}/{u.imageInfo.repository}</span>
                    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
                  </span>
                  <span className="truncate">{digestCrumb(u.imageInfo.digest)}</span>
                </Link>
                <TagCell tag={resolvedVersion(u) ?? vs.deployedTag} builtAt={vs.deployedBuiltAt} />
                <TagCell tag={vs.latestTag} builtAt={vs.latestBuiltAt} />
                <div>
                  {statusStyle ? (
                    <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", statusStyle.bg, statusStyle.text)}>
                      {statusStyle.label}
                    </span>
                  ) : (
                    <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-semibold text-muted-foreground">
                      No data
                    </span>
                  )}
                </div>
                <div>
                  <WorstCveCell report={vulnReport} />
                </div>
              </div>
              {issue && (
                <div className="flex items-center gap-2 px-5 pb-4">
                  <AlertTriangle className="size-3.5 shrink-0 text-status-minor-label" />
                  <span className="text-xs text-status-minor-label">{`${issue.type}: ${issue.message}`}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
