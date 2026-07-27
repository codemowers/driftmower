"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow, compactRelativeTimeFromNow, durationFromNow } from "@/lib/utils/format-time"
import { OCI_CREATED } from "@/lib/utils/oci-labels"
import { integrityInfo } from "@/lib/utils/image-artifacts"
import VulnerabilityBar from "./vulnerability-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage, StatusType } from "@/lib/cluster/reports"

const SEVERITY_STYLE: Record<StatusType, { bg: string; text: string; label: string }> = {
  major_behind: { bg: "bg-status-major-bg",   text: "text-status-major-label",   label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg",   text: "text-status-minor-label",   label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg",   text: "text-status-patch-label",   label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",      text: "text-status-ok-label",      label: "OK" },
  ahead:        { bg: "bg-status-ahead-bg",   text: "text-status-ahead-label",   label: "Ahead" },
  behind:       { bg: "bg-gray-100",          text: "text-muted-foreground",     label: "Behind" },
  no_data:      { bg: "bg-gray-100",          text: "text-muted-foreground",     label: "No data" },
  no_version:   { bg: "bg-gray-100",          text: "text-muted-foreground",     label: "No version" },
}

function severityStyle(statusType: string): { bg: string; text: string; label: string } {
  return SEVERITY_STYLE[statusType as StatusType] ?? {
    bg: "bg-gray-100",
    text: "text-muted-foreground",
    label: statusType.replace(/_/g, " "),
  }
}

function isoDate(iso: string): string {
  return iso.slice(0, 10)
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

export default function ImageTagStats({ usage }: { usage: ImageUsage }) {
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

  const builtAt = vs.deployedBuiltAt ?? usage.imageInfo.labels?.[OCI_CREATED]
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

        <Column label="Build Age" sub={builtAt ? `built ${isoDate(builtAt)}` : "build time unknown"}>
          {builtAt
            ? <p className="text-xl font-semibold text-foreground">{relativeTimeFromNow(builtAt)}</p>
            : <p className="text-xl font-semibold text-muted-foreground">no data</p>}
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
              ? "Trivy operator not installed"
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
