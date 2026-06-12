"use client"

import Link from "next/link"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { relativeTimeFromNow } from "@/lib/format-time"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage, Issue, StatusType } from "@/lib/cluster/reports"
import type { VulnerabilityReport, VulnerabilitySeverity, Vulnerability } from "@/lib/cluster/vulnerability"

const CVE_SEVERITY_STYLE: Record<VulnerabilitySeverity, { bg: string; text: string; label: string }> = {
  CRITICAL: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Critical" },
  HIGH:     { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "High" },
  MEDIUM:   { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Medium" },
  LOW:      { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "Low" },
  UNKNOWN:  { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "Unknown" },
  NONE:     { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "None" },
}

const CVE_SEVERITY_RANK: Record<VulnerabilitySeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4, NONE: 5,
}

function worstVulnerability(report: VulnerabilityReport): Vulnerability | null {
  const vulns = report.report.vulnerabilities
  if (vulns.length === 0) return null
  return [...vulns].sort((a, b) => {
    const rankDiff = (CVE_SEVERITY_RANK[a.severity] ?? 5) - (CVE_SEVERITY_RANK[b.severity] ?? 5)
    if (rankDiff !== 0) return rankDiff
    return b.score - a.score
  })[0]
}

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
  reportId: string | null
}

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string; label: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
}

const GRID = "grid-cols-[3fr_5fr_1.5fr_1.5fr_1.5fr_1.5fr]"
const HEADERS = ["Container", "Image", "Running", "Available", "Version drift", "Worst CVE"]

export default function ImagesTab({ usages, issues, workloadUid, reportId }: Props) {
  const vulnReports = useClusterState(s => s.vulnerabilityReports)

  if (usages.length === 0) {
    return <p className="text-sm text-muted-foreground">No container data for this pod.</p>
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <div className={cn("grid gap-4 border-b border-gray-100 bg-gray-50 px-4 py-3", GRID)}>
        {HEADERS.map(h => (
          <p key={h} className="text-xs font-medium text-muted-foreground">{h}</p>
        ))}
      </div>

      <div>
        {usages.map((u, idx) => {
          const vs = u.versionStatus
          const statusStyle = SEVERITY_STYLE[vs.statusType]
          const issue = issues.find(i => u.image.includes(i.image))
          const repoLabel = `${u.imageInfo.registry}/${u.imageInfo.repository}`
          const vulnReport = vulnReports === null ? undefined : vulnReports[u.imageInfo.digest] ?? null

          return (
            <div
              key={`${u.containerName}::${u.image}`}
              className={cn(idx > 0 && "border-t border-gray-100")}
            >
              <div className={cn("grid items-center gap-4 px-4 py-3", GRID)}>
                <span className="truncate font-mono text-sm font-medium text-foreground">
                  {u.containerName}
                </span>
                <Link
                  href={`/topmost-owners/${workloadUid}/images/${encodeURIComponent(u.imageInfo.digest)}${reportId ? `?report=${reportId}` : ""}`}
                  className="group inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-brand-text hover:underline"
                  title={repoLabel}
                >
                  <span className="truncate">{repoLabel}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
                </Link>
                <TagCell tag={vs.deployedTag} builtAt={vs.deployedBuiltAt} />
                <TagCell tag={vs.latestTag}   builtAt={vs.latestBuiltAt} />
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
