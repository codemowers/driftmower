"use client"

import MarkdownText from "@/app/components/markdown-text"

import { useEffect, useState } from "react"
import { Download, ExternalLink } from "lucide-react"
import { downloadSbom, loadImageScans } from "@/browser/image-scans"
import { cn } from "@/lib/utils/cn"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage } from "@/lib/cluster/reports"
import { advisoryUrl, type VulnerabilitySeverity, type Vulnerability } from "@/lib/features/vulnerability"
import SeverityBadge from "./severity-badge"
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

const DEFAULT_VISIBLE = 3

function sortVulns(vulns: Vulnerability[]): Vulnerability[] {
  return [...vulns].sort((a, b) => {
    const rankDiff = (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5)
    if (rankDiff !== 0) return rankDiff
    const scoreDiff = b.score - a.score
    if (scoreDiff !== 0) return scoreDiff
    return a.vulnerabilityID.localeCompare(b.vulnerabilityID)
  })
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
      <td className="py-2 pr-3 align-top whitespace-nowrap">
        <SeverityBadge severity={vuln.severity} />
      </td>
      <td className="py-2 pr-3 align-top whitespace-nowrap">
        <a
          href={advisoryUrl(vuln.vulnerabilityID)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs text-brand-text hover:underline"
        >
          {vuln.vulnerabilityID}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </td>
      <td className="py-2 pr-3 align-top whitespace-nowrap">
        <span className="font-mono text-xs text-foreground">{vuln.resource}</span>
      </td>
      <td className="py-2 pr-3 align-top whitespace-nowrap">
        <span className="font-mono text-xs text-foreground">{vuln.installedVersion}</span>
        {vuln.fixedVersion ? (
          <span className="font-mono text-xs text-foreground"> → {vuln.fixedVersion}</span>
        ) : (
          <span className="ml-1 text-xs text-muted-foreground">no fix</span>
        )}
      </td>
      <td className="py-2 pr-3 align-top text-right whitespace-nowrap">
        <span className="font-mono text-xs tabular-nums text-foreground">
          {vuln.score === 0 ? "—" : vuln.score}
        </span>
      </td>
      <td className="w-full min-w-48 py-2 align-top">
        <MarkdownText text={title} className="text-xs text-muted-foreground" />
      </td>
    </tr>
  )
}

export default function ImageVulnerabilities({ usage }: { usage: ImageUsage }) {
  const [showAll, setShowAll] = useState(false)
  const [sbomError, setSbomError] = useState<string | null>(null)

  const vulnReports = useClusterState(s => s.vulnerabilityReports)
  const vulnError = useClusterState(s => s.vulnerabilityReportsError)
  const scanStatus = useClusterState(s => s.imageScanStatuses[usage.imageInfo.digest])
  const vuln = vulnReports?.[usage.imageInfo.digest] ?? null

  useEffect(()=>{
    let cancelled=false
    void loadImageScans([usage],()=>cancelled).catch(error=>{
      if(!cancelled)useClusterState.setState(state=>({imageScanStatuses:{...state.imageScanStatuses,[usage.imageInfo.digest]:"unavailable"},vulnerabilityReportsError:(error as Error).message}))
    })
    return()=>{cancelled=true}
  },[usage])

  const summary = vuln?.report.summary ?? null
  const totalCount = summary
    ? summary.criticalCount + summary.highCount + summary.mediumCount + summary.lowCount + summary.unknownCount + summary.noneCount
    : 0
  const allZero = totalCount === 0

  const sorted = vuln ? sortVulns(vuln.report.vulnerabilities) : []
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE)

  return (
    <div className="min-w-0 rounded-xl border border-gray-200 bg-white px-6 py-5">
      <div className="-mx-6 mb-4 flex items-center justify-between border-b border-gray-200 px-6 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Vulnerabilities
        </p>
        {vuln && (
          <p className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {vuln.report.scanner.name} {vuln.report.scanner.version}
              {vuln.report.os?.family && ` · ${vuln.report.os.family} ${vuln.report.os.name}`}
              {` · ${compactRelativeTimeFromNow(vuln.report.updateTimestamp)}`}
            </span>
            {usage.imageInfo.containerImage && usage.imageInfo.digest && (
              <button type="button" title="Download the CycloneDX SBOM" onClick={() => {
                setSbomError(null)
                downloadSbom(usage.imageInfo.containerImage!, usage.imageInfo.digest!).catch((e: Error) => setSbomError(e.message))
              }} className="inline-flex items-center gap-1 text-brand-text hover:underline">
                <Download className="size-3.5" />SBOM
              </button>
            )}
          </p>
        )}
      </div>

      {sbomError && <p className="mb-2 text-sm text-status-major-label">{sbomError}</p>}

      {vulnError && (
        <p className="text-sm text-muted-foreground">
          Vulnerability scan reports could not be loaded: {vulnError}
        </p>
      )}

      {!vulnError && !vuln && (!scanStatus || scanStatus === "loading") && (
        <LoadingLine loading="scan" />
      )}

      {!vulnError && vuln === null && !!scanStatus && scanStatus !== "loading" && (
        <p className="text-sm text-muted-foreground">{scanStatus === "unavailable" || scanStatus === "invalid" ? "The vulnerability scan is unavailable for this digest." : scanStatus === "expired" ? "The cached vulnerability scan has expired for this digest." : "The vulnerability scan is pending for this digest."}</p>
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
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Advisory</th>
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Package</th>
                  <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Version</th>
                  <th className="pb-2 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">CVSS</th>
                  <th className="pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</th>
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
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll(s => !s)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {showAll
                  ? `Show top ${DEFAULT_VISIBLE} vulnerabilities`
                  : `Show all ${sorted.length} vulnerabilities`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
