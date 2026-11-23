"use client"

import { useMemo, useState } from "react"
import Card from "@/app/components/layout/card"
import ShowMore from "./show-more"
import VulnerabilityTable from "./vulnerability-table"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage } from "@/lib/cluster/reports"
import { CVE_SEVERITY_STYLE, type VulnerabilitySeverity } from "@/lib/features/vulnerability"
import { vulnerabilityRows } from "@/lib/features/vulnerability/rows"
import { scanCoverage, emptyScanMessage } from "@/lib/features/vulnerability/coverage"

const SEVERITIES: VulnerabilitySeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]

// CVEs in the running images of one scope, highest CVSS first. Coverage stays
// visible: an unscanned image is unknown, not clean, and failed scans say why.
// A single-image scope lists affected packages instead of images.
export default function VulnerabilitiesCard({ usages, limit = 5 }: { usages: ImageUsage[]; limit?: number }) {
  const reports = useClusterState(s => s.vulnerabilityReports)
  const statuses = useClusterState(s => s.imageScanStatuses)
  const failureReasons = useClusterState(s => s.imageScanFailures)
  const scanError = useClusterState(s => s.vulnerabilityReportsError)
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => vulnerabilityRows(usages, reports), [usages, reports])
  const coverage = scanCoverage(usages, statuses, new Set(Object.keys(reports ?? {})))
  if (coverage.total === 0) return null
  const digests = new Map<string, string>()
  for (const u of usages) if (!u.finished && u.imageInfo.digest) digests.set(u.imageInfo.digest, `${u.imageInfo.registry}/${u.imageInfo.repository}`)
  const single = digests.size === 1
  const failures = [...digests].flatMap(([digest, image]) => failureReasons[digest] ? [{ digest, image, final: statuses[digest] === "failed", reason: failureReasons[digest] }] : [])
  const counts = new Map<VulnerabilitySeverity, number>()
  for (const r of rows) { const s = r.severity === "NONE" ? "UNKNOWN" : r.severity; counts.set(s, (counts.get(s) ?? 0) + 1) }
  const meta = single ? undefined : `${coverage.complete} of ${coverage.total} images scanned`
  return (
    <Card flush title="Vulnerabilities" meta={meta} actions={rows.length > 0 && <span className="flex flex-wrap gap-2 text-xs">
      {SEVERITIES.filter(s => counts.get(s)).map(s => <span key={s} className={`rounded px-1.5 py-0.5 font-semibold tabular-nums ${CVE_SEVERITY_STYLE[s].bg} ${CVE_SEVERITY_STYLE[s].text}`}>{counts.get(s)} {CVE_SEVERITY_STYLE[s].label}</span>)}
    </span>}>
      {scanError && <p role="alert" className="px-5 py-4 text-sm text-status-major-label">Vulnerability scans could not be loaded: {scanError}</p>}
      {failures.map(f => <p key={f.digest} role="alert" className="border-b px-5 py-3 text-sm text-status-major-label">
        {f.final ? "Scan failed" : "Last scan attempt failed"}{!single && <> for <span className="font-mono text-xs">{f.image}</span></>}: {f.reason}
      </p>)}
      {!scanError && !reports && <p className="px-5 py-4 text-sm text-muted-foreground">Loading image scans…</p>}
      {reports && rows.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{emptyScanMessage(coverage)}</p>}
      {rows.length > 0 && <VulnerabilityTable rows={expanded ? rows : rows.slice(0, limit)} packages={single} />}
      <ShowMore total={rows.length} limit={limit} expanded={expanded} onToggle={() => setExpanded(e => !e)} noun="vulnerabilities" />
    </Card>
  )
}
