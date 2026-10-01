"use client"

import { useState } from "react"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage } from "@/lib/cluster/reports"
import type { VulnerabilitySeverity, Vulnerability } from "@/lib/features/vulnerability"
import LoadingLine from "@/app/components/loading-line"

const SEVERITY_STYLE: Record<VulnerabilitySeverity, { bg: string; text: string; label: string }> = {
  CRITICAL: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Critical" },
  HIGH:     { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "High" },
  MEDIUM:   { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Medium" },
  LOW:      { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "Low" },
  UNKNOWN:  { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "Unknown" },
  NONE:     { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "None" },
}

const SEVERITY_RANK: Record<VulnerabilitySeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4, NONE: 5,
}

const DEFAULT_VISIBLE = 15

function nvdUrl(cveId: string): string {
  return `https://nvd.nist.gov/vuln/detail/${cveId}`
}

function sortVulns(vulns: Vulnerability[]): Vulnerability[] {
  return [...vulns].sort((a, b) => {
    const rankDiff = (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5)
    if (rankDiff !== 0) return rankDiff
    const scoreDiff = b.score - a.score
    if (scoreDiff !== 0) return scoreDiff
    return a.vulnerabilityID.localeCompare(b.vulnerabilityID)
  })
}

function SeverityBadge({ severity }: { severity: VulnerabilitySeverity }) {
  const s = SEVERITY_STYLE[severity]
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap", s.bg, s.text)}>
      {s.label}
    </span>
  )
}

function LegendDot({ severity, count }: { severity: VulnerabilitySeverity; count: number }) {
  const s = SEVERITY_STYLE[severity]
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <span className={cn("size-2 rounded-full", s.bg)} />
      <span className={cn("font-semibold tabular-nums", s.text)}>{count}</span>
      <span className="text-muted-foreground">{s.label}</span>
    </span>
  )
}

function VulnRow({ vuln }: { vuln: Vulnerability }) {
  const title = vuln.title || vuln.resource

  return (
    <tr className="border-t border-gray-100">
      <td className="py-2 pr-3 align-top">
        <SeverityBadge severity={vuln.severity} />
      </td>
      <td className="py-2 pr-3 align-top">
        <a
          href={nvdUrl(vuln.vulnerabilityID)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs text-brand-text hover:underline"
        >
          {vuln.vulnerabilityID}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </td>
      <td className="max-w-[160px] py-2 pr-3 align-top">
        <span className="block truncate font-mono text-xs text-foreground" title={vuln.resource}>
          {vuln.resource}
        </span>
      </td>
      <td className="py-2 pr-3 align-top">
        <span className="font-mono text-xs text-foreground">{vuln.installedVersion}</span>
        {vuln.fixedVersion ? (
          <span className="font-mono text-xs text-foreground"> → {vuln.fixedVersion}</span>
        ) : (
          <span className="ml-1 text-xs text-muted-foreground">no fix</span>
        )}
      </td>
      <td className="py-2 pr-3 align-top text-right">
        <span className="font-mono text-xs tabular-nums text-foreground">
          {vuln.score === 0 ? "—" : vuln.score}
        </span>
      </td>
      <td className="hidden py-2 align-top md:table-cell">
        <span className="block truncate text-xs text-muted-foreground" title={title}>
          {title}
        </span>
      </td>
    </tr>
  )
}

export default function ImageVulnerabilities({ usage }: { usage: ImageUsage }) {
  const [showAll, setShowAll] = useState(false)

  const vulnReports = useClusterState(s => s.vulnerabilityReports)
  const vulnError = useClusterState(s => s.vulnerabilityReportsError)
  const vuln = vulnReports?.[usage.imageInfo.digest] ?? null

  const summary = vuln?.report.summary ?? null
  const totalCount = summary
    ? summary.criticalCount + summary.highCount + summary.mediumCount + summary.lowCount + summary.unknownCount + summary.noneCount
    : 0
  const allZero = totalCount === 0

  const sorted = vuln ? sortVulns(vuln.report.vulnerabilities) : []
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE)

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <div className="-mx-6 mb-4 flex items-center justify-between border-b border-gray-200 px-6 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Vulnerabilities
        </p>
        {vuln && (
          <p className="text-xs text-muted-foreground">
            {vuln.report.scanner.name} {vuln.report.scanner.version}
            {vuln.report.os?.family && ` · ${vuln.report.os.family} ${vuln.report.os.name}`}
            {` · ${compactRelativeTimeFromNow(vuln.report.updateTimestamp)}`}
          </p>
        )}
      </div>

      {vulnError && (
        <p className="text-sm text-muted-foreground">
          Vulnerability scan reports could not be loaded: {vulnError}
        </p>
      )}

      {!vulnError && vulnReports === null && (
        <LoadingLine loading="scan" />
      )}

      {!vulnError && vulnReports !== null && vuln === null && (
        <p className="text-sm text-muted-foreground">No Trivy scan for this digest</p>
      )}

      {vuln && allZero && (
        <p className="text-sm text-status-ok-label">No known vulnerabilities</p>
      )}

      {vuln && !allZero && summary && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-4">
              {summary.criticalCount > 0 && <LegendDot severity="CRITICAL" count={summary.criticalCount} />}
              {summary.highCount > 0 && <LegendDot severity="HIGH" count={summary.highCount} />}
              {summary.mediumCount > 0 && <LegendDot severity="MEDIUM" count={summary.mediumCount} />}
              {summary.lowCount > 0 && <LegendDot severity="LOW" count={summary.lowCount} />}
              {summary.unknownCount > 0 && <LegendDot severity="UNKNOWN" count={summary.unknownCount} />}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {totalCount} total · {sorted.filter(v => v.fixedVersion !== "").length} fixable
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Severity</th>
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">CVE</th>
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Package</th>
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Version</th>
                  <th className="pb-2 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">CVSS</th>
                  <th className="hidden pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground md:table-cell">Title</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((v, i) => (
                  <VulnRow key={`${v.vulnerabilityID}-${v.resource}-${i}`} vuln={v} />
                ))}
              </tbody>
            </table>
          </div>

          {sorted.length > DEFAULT_VISIBLE && (
            <div className="mt-4 flex items-center border-t border-gray-100 pt-3">
              <button
                onClick={() => setShowAll(s => !s)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {showAll
                  ? "Show less"
                  : `Show all ${sorted.length} vulnerabilities`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
