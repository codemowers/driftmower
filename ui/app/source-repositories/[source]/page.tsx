"use client"

import Link from "next/link"
import { imagePath } from "@/lib/utils/image-artifacts"
import { useCallback, useState } from "react"
import { useParams } from "next/navigation"
import { GitBranch } from "lucide-react"
import { sourceFindings,sourceImages } from "@/browser/catalog"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { safeSourceURL,type SourceRecord } from "@/lib/features/crawler/sources"
import ResourceHeader from "@/app/components/resource-header"
import SourceScrapeBadge from "@/app/components/source-scrape-badge"
import LicenseBadge from "@/app/components/license-badge"
import { classifyLicense } from "@/lib/features/crawler/license"
import CopyButton from "@/app/components/copy-button"

export default function SourceRepositoryDetail(){
 const {source:url}=useParams<{source:string}>()
 const cluster=useClusterState(s=>s.clusterName)
 const {linkTo}=useContextHref()
 const [page,setPage]=useState({url,offset:0})
 const offset=page.url===url?page.offset:0
 const load=useCallback(async(signal:AbortSignal)=>{
  const [catalog,images]=await Promise.all([sourceFindings<{sources:SourceRecord[]}>({url,summary:"true"},signal),sourceImages(url,offset,signal)])
  return {source:catalog.sources.find(source=>source.url===url),...images}
 },[url,offset])
 const result=useQuery({key:JSON.stringify([cluster,"source",url,offset]),load,interval:30_000})
 const source=result.data?.source,href=safeSourceURL(url)
 return <main className="flex w-full flex-col gap-6 px-7 py-12">
  <ResourceHeader icon={GitBranch} iconAriaLabel="Source repository" title={url.replace(/^https?:\/\//,"")} copyValue={url} breadcrumbs={[{label:"Source Repositories",href:linkTo("/source-repositories")},{label:url.replace(/^https?:\/\//,"")}]} subtitle={href?<a className="text-brand-text hover:underline" href={href} target="_blank" rel="noreferrer">Open upstream repository</a>:url}/>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading source repository…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Source repository unavailable: {result.error} <button className="underline" onClick={result.retry}>Retry</button></p>}
  {result.data&&<>
   <div className="flex flex-wrap items-center gap-3"><SourceScrapeBadge scrape={source}/>{source?.latest&&<span className="font-mono text-sm">Latest release: {source.latest.tag}</span>}</div>
   <section className="space-y-2 rounded-xl border bg-white p-5"><h2 className="text-sm font-semibold">Repository license</h2><LicenseBadge license={source?.license}/><p className="text-sm">{classifyLicense(source?.license).title}</p><p className="text-xs text-muted-foreground">Classification: {classifyLicense(source?.license).classification}{classifyLicense(source?.license).osi && classifyLicense(source?.license).classification !== "OSI approved" ? " · OSI approved" : ""}</p>{safeSourceURL(source?.license?.url??"")&&<a className="text-sm text-brand-text hover:underline" href={source!.license!.url} target="_blank" rel="noreferrer">Read license</a>}</section>
   {!!source?.errors?.length&&<section className="space-y-2 rounded-xl border bg-white p-5"><h2 className="text-sm font-semibold">Scrape errors</h2>{source.errors.map(error=><p key={error} className="break-words text-xs text-status-major-label">{error}</p>)}</section>}
   <section className="overflow-x-auto rounded-xl border bg-white">
    <header className="border-b px-5 py-4"><h2 className="text-sm font-semibold">Images built from this repository · {result.data.total}</h2><p className="mt-1 text-xs text-muted-foreground">Images recorded in the selected cluster, including unused images and images without version labels.</p></header>
    <table className="w-full text-left text-sm"><thead className="border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-5 py-3">Image</th><th className="px-3">Source version</th><th className="px-3">Status</th></tr></thead><tbody>
     {result.data.images.map(image=><tr key={image.name} className="border-b align-top last:border-0"><td className="px-5 py-4"><div className="flex items-start gap-2"><Link href={linkTo(`/container-images/${imagePath((image.image??image.name).split("@")[0].replace(/:[^/]*$/, ""))}`)} className="break-all font-mono text-brand-text hover:underline">{image.image??image.name}</Link><CopyButton value={image.image??image.name}/></div>{image.digest&&<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{image.digest}</p>}{image.references.length>0&&<details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Tags and digests · {image.references.length}</summary>{image.references.map(reference=><p key={reference} className="mt-1 break-all font-mono">{reference}</p>)}</details>}</td><td className="px-3 py-4 font-mono">{image.version||"Unknown"}</td><td className="px-3 py-4 text-xs">{image.unused?"Unused":"In use"}</td></tr>)}
    </tbody></table>
    {!result.data.total&&<p className="px-5 py-4 text-sm text-muted-foreground">No images from this repository have been observed.</p>}
   </section>
   {(offset>0||result.data.nextOffset!==undefined)&&<nav aria-label="Image pages" className="flex items-center gap-4 text-sm"><button disabled={!offset} onClick={()=>setPage({url,offset:Math.max(0,offset-100)})} className="rounded border px-3 py-1 disabled:opacity-40">Previous</button><span>{offset+1}–{offset+result.data.images.length} of {result.data.total}</span><button disabled={result.data.nextOffset===undefined} onClick={()=>setPage({url,offset:result.data?.nextOffset??offset})} className="rounded border px-3 py-1 disabled:opacity-40">Next</button></nav>}
  </>}
 </main>
}
