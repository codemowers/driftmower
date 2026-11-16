"use client"

import MarkdownText from "@/app/components/markdown-text"

import { useMemo, useState } from "react"
import PageHeader from "@/app/components/page-header"
import PageLoading from "@/app/components/page-loading"
import PrefetchLink from "@/app/components/prefetch-link"
import SeverityBadge from "@/app/components/image/severity-badge"
import { FilterSearchInput } from "@/app/components/filter-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { imagePath } from "@/lib/utils/image-artifacts"
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
  const { linkTo } = useContextHref()
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
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Vulnerabilities" subtitle="CVEs found by scanning the images that are running" />
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
              : (
                <div className="overflow-x-auto"><table className="w-full min-w-[48rem] table-fixed text-left text-sm"><colgroup><col className="w-28"/><col/><col className="w-[max(20rem,33.333%)]"/></colgroup>
                  <thead className="border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-5 py-3">Severity</th><th className="px-3 py-3">Vulnerability</th><th className="px-5 py-3">Affected images</th></tr></thead>
                  <tbody>{visible.map(row => <tr key={row.id} className="border-b align-top last:border-0">
                    <td className="px-5 py-4"><SeverityBadge severity={row.severity} score={row.score}/></td>
                    <td className="px-3 py-4"><PrefetchLink href={linkTo(`/vulnerabilities/${encodeURIComponent(row.id)}`)} className="font-mono text-sm text-brand-text hover:underline">{row.id}</PrefetchLink>
                      {row.title && <MarkdownText text={row.title} className="mt-1 line-clamp-2 text-sm"/>}
                    </td>
                    <td className="px-5 py-4"><div className="flex flex-col gap-1">{[...row.images].slice(0,3).map(image => <PrefetchLink key={image} href={linkTo(`/container-images/${imagePath(image)}`)} className="break-all font-mono text-xs text-brand-text hover:underline">{image}</PrefetchLink>)}{row.images.size>3&&<PrefetchLink href={linkTo(`/vulnerabilities/${encodeURIComponent(row.id)}`)} className="text-xs text-brand-text hover:underline">+{row.images.size-3} more</PrefetchLink>}</div></td>
                  </tr>)}</tbody>
                </table></div>
              )}
          </section>
        )}
      </main>
    </div>
  )
}
