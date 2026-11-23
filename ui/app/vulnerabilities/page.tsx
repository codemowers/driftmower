"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"


import { useMemo, useState } from "react"
import PageHeader from "@/app/components/page-header"
import PageLoading from "@/app/components/page-loading"
import VulnerabilityTable from "@/app/components/findings/vulnerability-table"
import SeverityBadge from "@/app/components/image/severity-badge"
import { FilterSearchInput } from "@/app/components/filter-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { type VulnerabilitySeverity } from "@/lib/features/vulnerability"
import { vulnerabilityRows } from "@/lib/features/vulnerability/rows"
import { scanCoverage, emptyScanMessage } from "@/lib/features/vulnerability/coverage"

const SEVERITIES: VulnerabilitySeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]

// Every CVE found in running images, highest CVSS score first.
export default function VulnerabilitiesPage() {
  const data = useClusterState(s => s.data)
  const reports = useClusterState(s => s.vulnerabilityReports)
  const statuses = useClusterState(s => s.imageScanStatuses)
  const scanError = useClusterState(s => s.vulnerabilityReportsError)
  const [severities, setSeverities] = useState<Set<VulnerabilitySeverity>>(new Set(SEVERITIES))
  const [search, setSearch] = useState("")

  const rows = useMemo(() => vulnerabilityRows(data?.report.imageUsages ?? [], reports), [data, reports])

  if (!data) return <PageLoading loading="vulnerabilities" />
  const coverage = scanCoverage(data.report.imageUsages, statuses, new Set(Object.keys(reports ?? {})))
  const q = search.toLowerCase()
  const visible = rows.filter(r => severities.has(r.severity === "NONE" ? "UNKNOWN" : r.severity) &&
    (!q || r.id.toLowerCase().includes(q) || r.title?.toLowerCase().includes(q) || [...r.packages, ...r.images].some(x => x.toLowerCase().includes(q))))
  const counts = new Map<VulnerabilitySeverity, number>()
  for (const r of rows) counts.set(r.severity, (counts.get(r.severity) ?? 0) + 1)

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.vulnerabilities} title="Vulnerabilities" subtitle="CVEs found by scanning the images that are running" />
        {scanError && <p role="alert" className="text-sm text-status-major-label">Vulnerability scans could not be loaded: {scanError}</p>}
        {reports && <p className="text-sm text-muted-foreground">{coverage.complete} of {coverage.total} running images fully scanned{coverage.partial ? ` · ${coverage.partial} partial` : ""}{coverage.pending ? ` · ${coverage.pending} pending` : ""}{coverage.expired ? ` · ${coverage.expired} expired` : ""}{coverage.unavailable ? ` · ${coverage.unavailable} unavailable` : ""}</p>}
        {!reports ? <PageLoading loading="image scans" /> : (
          <section className="rounded-xl border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-5 py-3">
              {SEVERITIES.map(s => (
                <button key={s} type="button" aria-pressed={severities.has(s)}
                  onClick={() => setSeverities(prev => { const next = new Set(prev); if (next.has(s)) next.delete(s); else next.add(s); return next })}
                  className={severities.has(s) ? "opacity-100" : "opacity-40"}>
                  <SeverityBadge severity={s} /> <span className="text-xs tabular-nums text-muted-foreground">{counts.get(s) ?? 0}</span>
                </button>
              ))}
              <div className="ml-auto w-64"><FilterSearchInput value={search} onChange={setSearch} placeholder="CVE, package or image" /></div>
            </div>
            {visible.length === 0
              ? <p className="px-5 py-8 text-center text-sm text-muted-foreground">{rows.length ? "No vulnerabilities match the filters." : emptyScanMessage(coverage)}</p>
              : <VulnerabilityTable rows={visible} />}
          </section>
        )}
      </Page>
    </>
  )
}
