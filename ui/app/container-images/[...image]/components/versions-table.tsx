"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { SEVERITY_STYLE } from "@/lib/cluster/status-style"
import {
  CVE_SEVERITY_STYLE,
  worstVulnerability,
  type VulnerabilityReport,
} from "@/lib/cluster/vulnerability"
import CopyButton from "@/app/components/copy-button"
import { integrityStyle } from "@/lib/utils/image-artifacts"
import type { ImageVersion } from "../../utils/image-entries"

const GRID = "grid-cols-[minmax(0,1.2fr)_minmax(0,1.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)]"
const HEADERS = ["Running", "Digest", "Containers", "Drift", "Integrity", "Worst CVE"]
const DIGEST_PREFIX_LENGTH = 19
const CHIP = "rounded-md px-2 py-1 text-xs font-semibold"

function WorstCve({ report }: { report: VulnerabilityReport | undefined }) {
  if (!report) {
    return <span className={cn(CHIP, "bg-gray-100 text-muted-foreground")}>No scan</span>
  }
  const worst = worstVulnerability(report)
  const style = worst ? CVE_SEVERITY_STYLE[worst.severity] : undefined
  if (!worst || !style) {
    return <span className={cn(CHIP, "bg-status-ok-bg text-status-ok-label")}>Clean</span>
  }
  return (
    <span className={cn(CHIP, "whitespace-nowrap", style.bg, style.text)}>
      {style.label}{worst.score > 0 && ` ${worst.score}`}
    </span>
  )
}

function headerTotals(versions: ImageVersion[]): string {
  const count = `${versions.length} digest${versions.length === 1 ? "" : "s"}`
  const pinned = [...new Set(versions.map(v => v.tag).filter(Boolean))]
  return versions.length > 1 && pinned.length === 1
    ? `${count}, all pinned as ${pinned[0]}`
    : count
}

export default function VersionsTable({
  versions,
  containerCount,
}: {
  versions: ImageVersion[]
  containerCount: number
}) {
  const reports = useClusterState(s => s.vulnerabilityReports)
  const searchParams = useSearchParams()

  function artifactHref(artifactKey: string): string {
    const params = new URLSearchParams(searchParams.toString())
    params.set("artifact", artifactKey)
    return `?${params.toString()}`
  }

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white">
      <div className="flex items-baseline justify-between gap-4 border-b border-gray-200 px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Versions running</p>
        <p className="shrink-0 text-xs text-muted-foreground">{headerTotals(versions)}</p>
      </div>

      <div className={cn("grid gap-4 border-b border-gray-100 px-5 py-3", GRID)}>
        {HEADERS.map(header => (
          <p key={header} className="text-xs font-medium text-muted-foreground">{header}</p>
        ))}
      </div>

      <div className="divide-y divide-gray-100">
        {versions.map(version => {
          const style = SEVERITY_STYLE[version.statusType]
          const integrity = integrityStyle(version.tagStatus)
          return (
            <div
              key={version.artifactKey}
              className={cn(
                "relative grid items-center gap-4 px-5 py-3",
                GRID,
                version.digest && "transition-colors hover:bg-brand-bg/40",
              )}
            >
              <span className="truncate font-mono text-sm text-foreground">
                {version.resolvedTag ?? version.tag ?? "—"}
              </span>

              <span className="flex min-w-0 items-center gap-1.5">
                {version.digest ? (
                  <>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {version.digest.slice(0, DIGEST_PREFIX_LENGTH)}…
                    </span>
                    <CopyButton value={version.digest} className="relative z-10 shrink-0" />
                  </>
                ) : (
                  <span className="truncate font-mono text-xs italic text-muted-foreground">no digest pinned</span>
                )}
              </span>

              <span className="text-sm tabular-nums text-foreground">
                {version.containerCount} of {containerCount}
              </span>

              <div>
                {style
                  ? <span className={cn(CHIP, style.bg, style.text)}>{style.label}</span>
                  : <span className={cn(CHIP, "bg-gray-100 text-muted-foreground")}>No data</span>}
              </div>

              <div>
                <span className={cn(CHIP, integrity.bg, integrity.text)}>{integrity.label}</span>
              </div>

              <div>
                <WorstCve report={version.digest ? reports?.[version.digest] : undefined} />
              </div>

              {version.digest && (
                <Link
                  href={artifactHref(version.artifactKey)}
                  aria-label={`Inspect ${version.resolvedTag ?? version.digest}`}
                  className="absolute inset-0"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
