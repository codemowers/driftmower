"use client"

import type { ReactNode } from "react"
import { ICONS } from "@/app/components/layout/icons"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { useImageAnalysis } from "@/lib/features/image-analysis"
import { imageBuildTime, IMAGE_TIME_SOURCES } from "@/lib/features/image-build-time"
import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow, compactRelativeTimeFromNow, durationFromNow, isoDate } from "@/lib/utils/format-time"
import { OCI_CREATED } from "@/lib/utils/oci-labels"
import { integrityInfo } from "@/lib/utils/image-artifacts"
import VulnerabilityBar from "./vulnerability-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { SEVERITY_STYLE, type StatusStyle } from "@/lib/cluster/styles/status-style"
import type { ImageUsage, StatusType } from "@/lib/cluster/reports"

const TimestampConflict = ICONS.timestampConflict

function severityStyle(statusType: string): StatusStyle {
  return SEVERITY_STYLE[statusType as StatusType] ?? {
    bg: "bg-status-neutral-bg",
    text: "text-status-neutral-label",
    label: statusType.replace(/_/g, " "),
  }
}

function Column({ label, children, sub }: { label: string; children: ReactNode; sub: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-5 py-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

export default function ImageTagStats({ usage, analysis }: { usage: ImageUsage; analysis: ReturnType<typeof useImageAnalysis> }) {
  const vulnReports = useClusterState(s => s.vulnerabilityReports)
  const vulnError = useClusterState(s => s.vulnerabilityReportsError)
  const vuln = vulnReports?.[usage.imageInfo.digest] ?? null

  const vs = usage.versionStatus
  const driftStyle = severityStyle(vs.statusType)
  const driftValue = vs.latestTag && vs.latestTag !== vs.deployedTag
    ? `${vs.deployedTag ?? "—"} → ${vs.latestTag}`
    : vs.deployedTag ?? "—"
  const behind = Math.max(vs.majorDifference, vs.minorDifference, vs.patchDifference)
  const isBehind = Boolean(vs.latestTag && vs.latestTag !== vs.deployedTag)
  const driftSubParts = [
    ...(behind > 1 ? [`${behind} behind`] : []),
    ...(isBehind && vs.latestBuiltAt ? [`available for ${durationFromNow(vs.latestBuiltAt)}`] : []),
  ]

  const buildTime = imageBuildTime(usage.imageInfo.labels?.[OCI_CREATED], analysis.data?.images[usage.imageInfo.digest])
  const primaryTime = buildTime.primary
  const buildCaption = primaryTime
    ? primaryTime.source === "file"
      ? `file modified ${isoDate(primaryTime.timestamp)} · estimate`
      : `built ${isoDate(primaryTime.timestamp)} · ${primaryTime.source === "label" ? "created label" : "config JSON"}`
    : analysis.loading ? "Loading image timestamps…" : analysis.error ? "Image timestamps unavailable" : "build time unknown"
  const integrity = integrityInfo(usage)

  const summary = vuln?.report.summary ?? null
  const vulnTotal = summary
    ? summary.criticalCount + summary.highCount + summary.mediumCount + summary.lowCount
    : 0
  const fixable = vuln ? vuln.report.vulnerabilities.filter(v => v.fixedVersion).length : 0

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="grid grid-cols-[1fr_1fr_1fr_1.4fr] divide-x divide-gray-200">
        <Column
          label="Drift"
          sub={
            <div className="flex items-center gap-1.5">
              <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", driftStyle.bg, driftStyle.text)}>
                {driftStyle.label}
              </span>
              {driftSubParts.length > 0 && <span>{driftSubParts.join(" · ")}</span>}
            </div>
          }
        >
          <p className="text-xl font-semibold tabular-nums text-foreground">{driftValue}</p>
        </Column>

        <Column label="Build Age" sub={buildCaption}>
          <div className="flex items-center gap-2">
            {primaryTime
              ? <p className="text-xl font-semibold text-foreground">{primaryTime.source === "file" && "≈ "}{relativeTimeFromNow(primaryTime.timestamp)}</p>
              : <p className="text-xl font-semibold text-muted-foreground">{analysis.loading ? "loading" : "no data"}</p>}
            {buildTime.conflict && <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="Image timestamps differ by at least one hour" className="rounded text-status-major-label focus-visible:outline-2 focus-visible:outline-offset-2">
                  <TimestampConflict className="size-4" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm flex-col items-start gap-2">
                <p>Image timestamps differ by at least one hour.</p>
                <ul className="space-y-1">{buildTime.facts.map((fact, i) => <li key={`${fact.source}-${fact.digest ?? i}`}>
                  {IMAGE_TIME_SOURCES[fact.source]}{i === 0 ? " (primary)" : ""}: {new Date(fact.timestamp).toLocaleString()}
                  {fact.digest && <span className="block break-all font-mono text-xs">{fact.digest}</span>}
                </li>)}</ul>
                <p>File modification times may be preserved or normalized during a build.</p>
              </TooltipContent>
            </Tooltip>}
          </div>
        </Column>

        <Column label="Integrity" sub={integrity.caption}>
          <p className={cn("text-xl font-semibold", integrity.textClass)}>{integrity.value}</p>
        </Column>

        <Column
          label="Vulnerabilities"
          sub={vuln
            ? <>
                <span className="block">{vulnTotal} total · {fixable} fixable</span>
                <span className="block">scanned {compactRelativeTimeFromNow(vuln.report.updateTimestamp)}</span>
              </>
            : vulnError
              ? "No scan results available"
              : "no Trivy scan"}
        >
          {!summary
            ? <p className="text-xl font-semibold text-muted-foreground">{vulnError ? "unavailable" : "not scanned"}</p>
            : vulnTotal === 0
              ? <p className="text-xl font-semibold text-status-ok-label">none</p>
              : <VulnerabilityBar summary={summary} />}
        </Column>
      </div>
    </div>
  )
}
