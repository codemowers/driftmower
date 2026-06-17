"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow, compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage, StatusType } from "@/lib/cluster/reports"
import type { VulnerabilitySummary } from "@/lib/cluster/vulnerability"

type Tone = "ok" | "patch" | "minor" | "major" | "muted"

const TONE_TEXT: Record<Tone, string> = {
  ok:    "text-status-ok-label",
  patch: "text-status-patch-label",
  minor: "text-status-minor-label",
  major: "text-status-major-label",
  muted: "text-muted-foreground",
}

const SEVERITY_STYLE: Record<StatusType, { bg: string; text: string; label: string }> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
  ahead:        { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "Ahead" },
  no_data:      { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "No data" },
  no_version:   { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "No version" },
}

function severityStyle(statusType: string): { bg: string; text: string; label: string } {
  return SEVERITY_STYLE[statusType as StatusType] ?? {
    bg: "bg-gray-100",
    text: "text-muted-foreground",
    label: statusType.replace(/_/g, " "),
  }
}

const VULN_SEGMENTS: Array<{ key: keyof VulnerabilitySummary; barBg: string; barText: string }> = [
  { key: "lowCount",      barBg: "bg-gray-100",        barText: "text-muted-foreground" },
  { key: "mediumCount",   barBg: "bg-status-patch-bg", barText: "text-status-patch-label" },
  { key: "highCount",     barBg: "bg-status-minor-bg", barText: "text-status-minor-label" },
  { key: "criticalCount", barBg: "bg-status-major-bg", barText: "text-status-major-label" },
]

const MIN_PERCENTAGE_FOR_COUNT = 12

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

function Value({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return <p className={cn("text-xl font-semibold", TONE_TEXT[tone])}>{children}</p>
}

function integrityInfo(tagStatus: string): { value: string; sub: string; tone: Tone } {
  if (tagStatus === "match") return { value: "match", sub: "tag matches digest", tone: "ok" }
  if (tagStatus === "drifted") return { value: "drifted", sub: "tag/digest differ", tone: "minor" }
  return { value: "unknown", sub: "unverified", tone: "muted" }
}

function VulnBar({ summary }: { summary: VulnerabilitySummary }) {
  const total = summary.criticalCount + summary.highCount + summary.mediumCount + summary.lowCount
  return (
    <div className="flex h-7 w-full flex-row gap-1">
      {VULN_SEGMENTS.filter(s => summary[s.key] > 0).map(s => {
        const pct = (summary[s.key] / total) * 100
        return (
          <div
            key={s.key}
            className={cn("flex items-center justify-center overflow-hidden rounded-md", s.barBg)}
            style={{ width: `${pct}%` }}
          >
            {pct >= MIN_PERCENTAGE_FOR_COUNT && (
              <span className={cn("px-1 text-xs font-semibold tabular-nums", s.barText)}>
                {summary[s.key]}
              </span>
            )}
          </div>
        )
      })}
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

  const builtAt = vs.deployedBuiltAt
  const integrity = integrityInfo(usage.tagStatus)

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
              {behind > 1 && <span>{behind} behind</span>}
            </div>
          }
        >
          <p className="text-xl font-semibold tabular-nums text-foreground">{driftValue}</p>
        </Column>

        <Column label="Build Age" sub={builtAt ? `built ${isoDate(builtAt)}` : "build time unknown"}>
          {builtAt
            ? <p className="text-xl font-semibold text-foreground">{relativeTimeFromNow(builtAt)}</p>
            : <Value tone="muted">no data</Value>}
        </Column>

        <Column label="Integrity" sub={integrity.sub}>
          <Value tone={integrity.tone}>{integrity.value}</Value>
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
          {!vuln
            ? <Value tone="muted">{vulnError ? "unavailable" : "not scanned"}</Value>
            : vulnTotal === 0
              ? <Value tone="ok">none</Value>
              : <VulnBar summary={summary!} />}
        </Column>
      </div>
    </div>
  )
}
