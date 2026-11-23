"use client"

import SourceCard from "@/app/components/image/source-card"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { SEVERITY_STYLE } from "@/lib/cluster/styles/status-style"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { aggregateVulnerabilities } from "@/lib/features/vulnerability"
import VulnerabilityBar from "@/app/components/image/vulnerability-bar"
import { integrityInfo } from "@/lib/utils/image-artifacts"
import { StatGrid, StatCell, StatValue, StatCaption } from "@/app/components/stats-card"
import type { ImageDetail, ImageVersion } from "../../utils/image-entries"

const PILL = "rounded-md px-2 py-0.5 text-xs font-semibold"

function DriftPills({ versions }: { versions: ImageVersion[] }) {
  const distinct = [...new Set(versions.map(v => v.statusType))]
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {distinct.map(status => {
        const style = SEVERITY_STYLE[status]
        return <span key={status} className={cn(PILL, style.bg, style.text)}>{style.label}</span>
      })}
    </div>
  )
}

function DriftCell({ detail }: { detail: ImageDetail }) {
  const { versions, latestTag } = detail

  if (versions.length > 1) {
    return (
      <StatCell label="Drift">
        <StatValue>{versions.length} versions</StatValue>
        <DriftPills versions={versions} />
      </StatCell>
    )
  }

  const version = versions[0]
  const deployed = version?.tag ?? "—"
  const style = SEVERITY_STYLE[version?.statusType ?? "no_data"]

  return (
    <StatCell label="Drift">
      <StatValue className="font-mono">
        {latestTag && latestTag !== deployed ? `${deployed} → ${latestTag}` : deployed}
      </StatValue>
      <div className="flex items-center gap-1.5">
        <span className={cn(PILL, style.bg, style.text)}>{style.label}</span>
      </div>
    </StatCell>
  )
}

function IntegrityCell({ detail }: { detail: ImageDetail }) {
  const { versions, containerCount } = detail
  const version = versions[0]
  const integrity = version ? integrityInfo(version.usage) : undefined
  const verified = versions.filter(v => v.tagStatus === "match").reduce((sum, v) => sum + v.containerCount, 0)
  return <StatCell label="Integrity">
    {versions.length > 1 ? <>
      <StatValue>{verified} <span className="text-sm font-medium text-muted-foreground">of {containerCount} verified</span></StatValue>
      <StatCaption>{containerCount - verified} containers run a digest the registry cannot confirm</StatCaption>
    </> : integrity ? <>
      <p className={cn("mt-0.5 text-xl font-semibold", integrity.textClass)}>{integrity.value}</p>
      <StatCaption>{integrity.caption}</StatCaption>
    </> : <StatCaption>Nothing to verify</StatCaption>}
    {version && <SourceCard usage={version.usage} showRevision={false} embedded />}
  </StatCell>
}

export default function ImageStats({ detail }: { detail: ImageDetail }) {
  const reports = useClusterState(s => s.vulnerabilityReports)
  const scanStatuses = useClusterState(s => s.imageScanStatuses)
  const reportsError = useClusterState(s => s.vulnerabilityReportsError)

  const states=detail.digests.map(d=>scanStatuses[d]??"loading")
  const scanCaption=states.includes("failed")?"Scan failed":states.includes("partial")?"Partial scan coverage":states.includes("expired")?"Stored scan expired from the operator cache":states.includes("unavailable")?"Scan results unavailable":states.includes("loading")?"Loading scan results":"Waiting for a scan"
  const { containerCount, versions } = detail
  const scanned = reports === null ? [] : detail.digests.map(d => reports[d]).filter(Boolean)
  const { summary, total, fixable } = aggregateVulnerabilities(scanned)
  const scannedAt = scanned
    .map(r => r.report.updateTimestamp)
    .sort()
    .at(-1)

  const usedByParts = [
    `${detail.workloadRows.length} workload${detail.workloadRows.length === 1 ? "" : "s"}`,
    `${detail.namespaceCount} namespace${detail.namespaceCount === 1 ? "" : "s"}`,
    ...(detail.releases.length > 0
      ? [`${detail.releases.length} release${detail.releases.length === 1 ? "" : "s"}`]
      : []),
  ]

  const coverage = versions.length > 1 ? `${scanned.length} of ${versions.length} digests scanned` : null
  const vulnerabilityCaption = [
    `${total} total`,
    `${fixable} fixable`,
    ...(coverage ? [coverage] : []),
    ...(scannedAt ? [`scanned ${compactRelativeTimeFromNow(scannedAt)}`] : []),
  ].join(" · ")

  return (
    <StatGrid>
      <DriftCell detail={detail} />

      <StatCell label="Used By">
        <StatValue>
          {containerCount} <span className="text-sm font-medium text-muted-foreground">
            {containerCount === 1 ? "container" : "containers"}
          </span>
        </StatValue>
        <StatCaption>{usedByParts.join(" · ")}</StatCaption>
      </StatCell>

      <IntegrityCell detail={detail} />

      <StatCell label="Vulnerabilities">
        {total > 0
          ? <div className="mt-0.5"><VulnerabilityBar summary={summary} /></div>
          : (
            <p className="mt-0.5 text-xl font-medium text-foreground">
              {reports === null
                ? (reportsError ? "unavailable" : "loading")
                : scanned.length > 0 ? (states.includes("partial")?"partial":"none") : states.includes("loading")?"loading":"not scanned"}
            </p>
          )}
        <StatCaption>
          {scanned.length > 0
            ? vulnerabilityCaption
            : reportsError
              ? reportsError
              : scanCaption}
        </StatCaption>
      </StatCell>
    </StatGrid>
  )
}
