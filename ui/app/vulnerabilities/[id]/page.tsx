"use client"
import { packageIdentity, packagePath } from "@/lib/features/packages/types"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"
import Card from "@/app/components/layout/card"

import { useMemo } from "react"
import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import PageLoading from "@/app/components/page-loading"
import PrefetchLink from "@/app/components/prefetch-link"
import MarkdownText from "@/app/components/markdown-text"
import SeverityBadge from "@/app/components/image/severity-badge"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { containerImageHref } from "@/lib/utils/image-artifacts"
import { scanCoverage } from "@/lib/features/vulnerability/coverage"
import { vulnerabilityRows } from "@/lib/features/vulnerability/rows"
import { safeSourceURL } from "@/lib/features/crawler/sources"

export default function VulnerabilityDetail() {
  const { id } = useParams<{ id: string }>()
  const data = useClusterState(s => s.data)
  const reports = useClusterState(s => s.vulnerabilityReports)
  const error = useClusterState(s => s.vulnerabilityReportsError)
  const statuses = useClusterState(s => s.imageScanStatuses)
  const { linkTo } = useContextHref()
  const row = useMemo(() => vulnerabilityRows(data?.report.imageUsages ?? [], reports).find(row => row.id === id), [data, reports, id])
  if (!data) return <PageLoading loading="vulnerability"/>
  const links = [...new Set([row?.link, ...(row?.findings.flatMap(f => [f.vulnerability.primaryLink, ...f.vulnerability.links]) ?? [])])].filter((link): link is string => Boolean(safeSourceURL(link)))
  const coverage = scanCoverage(data.report.imageUsages, statuses, new Set(Object.keys(reports ?? {})))
  const loading = reports === null || data.report.imageUsages.some(usage => !usage.finished && statuses[usage.imageInfo.digest] === "loading")
  return <Page>
    <ResourceHeader icon={ICONS.vulnerabilities} iconAriaLabel="Vulnerability" title={id} subtitle="Vulnerability findings in running images" breadcrumbs={[{label:"Vulnerabilities",href:linkTo("/vulnerabilities")},{label:id}]}/>
    {error && <p role="alert" className="text-sm text-status-major-label">Some scans could not be loaded: {error}</p>}
    {reports && <p className="text-sm text-muted-foreground">{coverage.complete} of {coverage.total} running images fully scanned.{coverage.complete < coverage.total && " Coverage is incomplete; unscanned images may also be affected. Partial scans can exclude Java archives."}</p>}
    {!row ? <p className="text-sm text-muted-foreground">{loading ? "Loading image scans…" : "This vulnerability is not present in the available scans of running images."}</p> : <>
      <Card title="Vulnerability">
        <div className="flex flex-wrap items-center gap-3">
          <SeverityBadge severity={row.severity} score={row.score} />
          <p className="text-sm text-muted-foreground">{row.images.size} affected images · {row.packages.size} package versions · {row.workloads.size} workloads</p>
        </div>
        {row.title && <MarkdownText text={row.title} />}
        <p className="text-xs text-muted-foreground">Severity and CVSS show the highest values reported by the available scans.</p>
      </Card>
      <Card title="Affected images and packages" flush><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted text-xs text-muted-foreground"><tr>{["Image","Package","Installed","Fixed in","Target"].map(title=><th key={title} className="px-5 py-3">{title}</th>)}</tr></thead><tbody>{row.findings.map((finding,index)=><tr key={index} className="border-t align-top"><td className="px-5 py-3"><PrefetchLink href={linkTo(containerImageHref(finding.image, finding.digest))} className="break-all font-mono text-xs text-brand-text hover:underline">{finding.image}</PrefetchLink><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{finding.digest}</p></td><td className="px-5 py-3 font-mono text-xs">{finding.vulnerability.packagePURL?<PrefetchLink href={linkTo(packagePath(packageIdentity(finding.vulnerability.packagePURL)))} className="text-brand-text hover:underline">{finding.vulnerability.resource}</PrefetchLink>:finding.vulnerability.resource}</td><td className="px-5 py-3 font-mono text-xs">{finding.vulnerability.installedVersion}</td><td className="px-5 py-3 font-mono text-xs">{finding.vulnerability.fixedVersion || "No fix reported"}</td><td className="break-all px-5 py-3 font-mono text-xs">{finding.vulnerability.target}</td></tr>)}</tbody></table></div></Card>
      <Card title="Affected workloads">{[...row.workloads.values()].map(w=><PrefetchLink key={w.uid} href={linkTo(`/topmost-owners/${w.uid}`)} className="block font-mono text-sm text-brand-text hover:underline">{w.namespace}/{w.name}</PrefetchLink>)}{row.workloads.size === 0 && <p className="text-sm text-muted-foreground">No workload association is available for these findings.</p>}</Card>
      {!!links.length&&<Card title="References">{links.map(link=><a key={link} href={link} target="_blank" rel="noreferrer" className="block break-all text-xs text-brand-text hover:underline">{link}</a>)}</Card>}
    </>}
  </Page>
}
