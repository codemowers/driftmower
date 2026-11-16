"use client"

import { useMemo } from "react"
import { useParams } from "next/navigation"
import { ShieldAlert } from "lucide-react"
import ResourceHeader from "@/app/components/resource-header"
import PageLoading from "@/app/components/page-loading"
import PrefetchLink from "@/app/components/prefetch-link"
import MarkdownText from "@/app/components/markdown-text"
import SeverityBadge from "@/app/components/image/severity-badge"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { imagePath } from "@/lib/utils/image-artifacts"
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
  const links = [...new Set(row?.findings.flatMap(f => [f.vulnerability.primaryLink, ...f.vulnerability.links]) ?? [])].filter(link => safeSourceURL(link))
  const loading = reports === null || Object.values(statuses).includes("loading")
  return <main className="flex w-full flex-col gap-6 px-7 py-12">
    <ResourceHeader icon={ShieldAlert} iconAriaLabel="Vulnerability" title={id} subtitle="Vulnerability findings in running images" breadcrumbs={[{label:"Vulnerabilities",href:linkTo("/vulnerabilities")},{label:id}]}/>
    {error && <p role="alert" className="text-sm text-status-major-label">Some scans could not be loaded: {error}</p>}
    {!row ? <p className="text-sm text-muted-foreground">{loading ? "Loading image scans…" : "This vulnerability is not present in the available scans of running images."}</p> : <>
      <section className="space-y-3 rounded-xl border bg-white p-5"><div className="flex items-center gap-3"><SeverityBadge severity={row.severity}/>{row.score>0&&<span className="text-sm">CVSS {row.score}</span>}</div><MarkdownText text={row.title}/><p className="text-sm text-muted-foreground">{row.images.size} affected images · {row.workloads.size} workloads</p><a className="text-sm text-brand-text hover:underline" href={safeSourceURL(row.link)} target="_blank" rel="noreferrer">View advisory</a></section>
      <section className="overflow-x-auto rounded-xl border bg-white"><h2 className="border-b px-5 py-4 text-sm font-semibold">Affected images and packages</h2><table className="w-full text-left text-sm"><thead className="bg-muted text-xs text-muted-foreground"><tr>{["Image","Package","Installed","Fixed in","Target"].map(title=><th key={title} className="px-5 py-3">{title}</th>)}</tr></thead><tbody>{row.findings.map((finding,index)=><tr key={index} className="border-t align-top"><td className="px-5 py-3"><PrefetchLink href={linkTo(`/container-images/${imagePath(finding.image)}`)} className="break-all font-mono text-xs text-brand-text hover:underline">{finding.image}</PrefetchLink><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{finding.digest}</p></td><td className="px-5 py-3 font-mono text-xs">{finding.vulnerability.resource}</td><td className="px-5 py-3 font-mono text-xs">{finding.vulnerability.installedVersion}</td><td className="px-5 py-3 font-mono text-xs">{finding.vulnerability.fixedVersion || "No fix reported"}</td><td className="break-all px-5 py-3 font-mono text-xs">{finding.vulnerability.target}</td></tr>)}</tbody></table></section>
      <section className="space-y-2 rounded-xl border bg-white p-5"><h2 className="text-sm font-semibold">Affected workloads</h2>{[...row.workloads.values()].map(w=><PrefetchLink key={w.uid} href={linkTo(`/topmost-owners/${w.uid}`)} className="block font-mono text-sm text-brand-text hover:underline">{w.namespace}/{w.name}</PrefetchLink>)}</section>
      {!!links.length&&<section className="space-y-2 rounded-xl border bg-white p-5"><h2 className="text-sm font-semibold">References</h2>{links.map(link=><a key={link} href={link} target="_blank" rel="noreferrer" className="block break-all text-xs text-brand-text hover:underline">{link}</a>)}</section>}
    </>}
  </main>
}
