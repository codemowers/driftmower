"use client"

import { useCallback, useState } from "react"
import Link from "next/link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { GitBranch } from "lucide-react"
import ResourceHeader from "@/app/components/resource-header"
import LicenseBadge from "@/app/components/license-badge"
import SourceScrapeBadge from "@/app/components/source-scrape-badge"
import { sourceFindings } from "@/browser/catalog"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { scrapeState, sourceRepositoryPath, type SourceRecord } from "@/lib/features/crawler/sources"

type Catalog={sources:SourceRecord[];missing?:string[]}

export default function SourceRepositoriesPage(){
 const {linkTo}=useContextHref()
 const cluster=useClusterState(s=>s.clusterName)
 const [filter,setFilter]=useState("")
 const load=useCallback((signal:AbortSignal)=>sourceFindings<Catalog>({summary:"true"},signal),[])
 const result=useQuery({key:JSON.stringify([cluster,"source-repositories"]),load,interval:30_000})
 const sources=result.data?.sources??[]
 const query=filter.trim().toLowerCase()
 const rows=sources.filter(source=>[source.url,source.latest?.tag,source.license?.spdxId,source.license?.name,...(source.errors??[])].filter(Boolean).join(" ").toLowerCase().includes(query)).sort((a,b)=>a.url.localeCompare(b.url))
 const active=sources.filter(source=>source.scraping).length
 const failed=sources.filter(source=>scrapeState(source)==="failed").length
 return <main className="flex w-full flex-col gap-6 px-7 py-12">
  <ResourceHeader icon={GitBranch} iconAriaLabel="Source repositories" title="Source Repositories" breadcrumbs={[{label:"Source Repositories"}]} subtitle="Source repositories used by this cluster, with shared release and security evidence"/>
  <div className="flex flex-wrap items-center justify-between gap-3">
   <input aria-label="Filter source repositories" placeholder="Filter repository, version or error…" value={filter} onChange={event=>setFilter(event.target.value)} className="w-full max-w-md rounded-lg border bg-white px-3 py-2 text-sm"/>
   <p className="text-xs text-muted-foreground">{sources.length} repositories · {active} scraping · {failed} failed · refreshes every 30 seconds</p>
  </div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading source repositories…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Source repositories unavailable: {result.error} <button className="underline" onClick={result.retry}>Retry</button></p>}
  {!!result.data?.missing?.length&&<p className="text-sm text-muted-foreground">Crawler inventory unavailable: {result.data.missing.join(", ")}</p>}
  <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
   <thead className="border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-5 py-3">Repository</th><th className="px-3">Latest release</th><th className="px-3">License</th><th className="px-3">Scrape status</th></tr></thead>
   <tbody>{rows.map(source=><tr key={source.url} className="border-b align-top last:border-0">
    <td className="px-5 py-4"><Link href={linkTo(sourceRepositoryPath(source.url))} className="break-all font-mono text-brand-text hover:underline">{source.url.replace(/^https?:\/\//,"")}</Link></td>
    <td className="px-3 py-4 font-mono">{source.latest?.tag??"Unknown"}</td>
    <td className="px-3 py-4"><LicenseBadge license={source.license}/></td>
    <td className="px-3 py-4"><SourceScrapeBadge scrape={source}/></td>
   </tr>)}</tbody>
  </table>{result.data&&!rows.length&&<p className="px-5 py-4 text-sm text-muted-foreground">{query?"No matching source repositories.":"No source repositories are available in the crawler catalog."}</p>}</div>
 </main>
}
