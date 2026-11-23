"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useCallback, useState } from "react"
import Link from "next/link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import PageHeader from "@/app/components/page-header"
import BaseImageCatalog from "@/app/components/image/base-image-catalog"
import LicenseBadge from "@/app/components/license-badge"
import SourceScrapeBadge from "@/app/components/source-scrape-badge"
import { sourceFindings } from "@/browser/catalog"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { sourceRepositoryPath, type SourceRecord } from "@/lib/features/crawler/sources"

type Catalog={sources:SourceRecord[];missing?:string[]}

export default function SourceRepositoriesPage(){
 const {linkTo}=useContextHref()
 const cluster=useClusterState(s=>s.clusterName)
 const [filter,setFilter]=useState("")
 const load=useCallback((signal:AbortSignal)=>sourceFindings<Catalog>({summary:"true"},signal),[])
 const result=useQuery({key:JSON.stringify([cluster,"source-repositories"]),load,interval:300_000})
 const sources=result.data?.sources??[]
 const query=filter.trim().toLowerCase()
 const rows=sources.filter(source=>[source.url,source.latest?.tag,source.license?.spdxId,source.license?.name,source.unauthorized?"Unauthorized":undefined,...(source.errors??[])].filter(Boolean).join(" ").toLowerCase().includes(query)).sort((a,b)=>a.url.localeCompare(b.url))
 const active=sources.filter(source=>source.scraping).length
 const unauthorized=sources.filter(source=>source.unauthorized).length
 const failed=sources.filter(source=>source.errors?.length&&!source.unauthorized).length
 return <Page>
  <PageHeader icon={ICONS.sources} title="Source Repositories" subtitle="Where releases, advisories and base images are scraped from, and how each scrape went"/>
  <div className="flex flex-wrap items-center justify-between gap-3">
   <input aria-label="Filter source repositories" placeholder="Filter repository, version or error…" value={filter} onChange={event=>setFilter(event.target.value)} className="w-full max-w-md rounded-lg border bg-white px-3 py-2 text-sm"/>
   <p className="text-xs text-muted-foreground">{sources.length} repositories · {active} scraping · {unauthorized} unauthorized · {failed} failed · refreshes every 30 seconds</p>
  </div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading source repositories…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Source repositories unavailable: {result.error} <button className="underline" onClick={result.retry}>Retry</button></p>}
  {!!result.data?.missing?.length&&<p className="text-sm text-muted-foreground">Crawler inventory unavailable: {result.data.missing.join(", ")}</p>}
  <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white"><table className="w-full text-left text-sm">
   <thead className="border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-5 py-3">Repository</th><th className="px-3">Latest release</th><th className="px-3">License</th></tr></thead>
   <tbody>{rows.map(source=><tr key={source.url} className="border-b align-top last:border-0">
    <td className="px-5 py-4"><span className="inline-flex items-center gap-2"><Link href={linkTo(sourceRepositoryPath(source.url))} className="break-all font-mono text-brand-text hover:underline">{source.url.replace(/^https?:\/\//,"")}</Link><SourceScrapeBadge scrape={source}/></span></td>
    <td className="px-3 py-4 font-mono">{source.latest?.tag??"Unknown"}</td>
    <td className="px-3 py-4"><LicenseBadge license={source.license}/></td>
   </tr>)}</tbody>
  </table>{result.data&&!rows.length&&<p className="px-5 py-4 text-sm text-muted-foreground">{query?"No matching source repositories.":"No source repositories are available in the crawler catalog."}</p>}</div>
  <BaseImageCatalog/>
 </Page>
}
