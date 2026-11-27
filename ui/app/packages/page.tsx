"use client"
import { useCallback, useState } from "react"
import Link from "next/link"
import Page from "@/app/components/layout/page"
import PageHeader from "@/app/components/page-header"
import Card from "@/app/components/layout/card"
import { ICONS } from "@/app/components/layout/icons"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useSearchParam } from "@/lib/hooks/use-search-param"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { callTool } from "@/browser/connection"
import {LIFECYCLE_STATES} from "@/lib/features/packages/lifecycle"
import {containerImageHref} from "@/lib/utils/image-artifacts"
import { filterPackages, packageName, packagePath, type PackagesResult } from "@/lib/features/packages/types"
import { PackageCoverage, PackageTags, LifecycleLink } from "@/app/components/packages/evidence"

export default function PackagesPage(){
 const cluster=useClusterState(s=>s.clusterName),{linkTo}=useContextHref()
 const [search,setSearch]=useState("")
 const [tagParam,setTagParam]=useSearchParam("tags"),selected=(tagParam??"").split(",").filter(Boolean)
 const [stateParam,setStateParam]=useSearchParam("lifecycle"),selectedStates=(stateParam??"").split(",").filter(Boolean)
 const load=useCallback((signal:AbortSignal)=>callTool<PackagesResult>("get_packages",{},signal),[])
 const result=useQuery({key:JSON.stringify([cluster,"packages"]),load,interval:30_000})
 const packages=result.data?.packages??[],rows=filterPackages(packages,search,selected,selectedStates)
 const tags=[...new Set(packages.flatMap(p=>p.tags))].sort()
 return <Page>
  <PageHeader icon={ICONS.packages} title="Packages" subtitle="Packages identified in retained SBOMs of running images"/>
  <PackageCoverage data={result.data}/>
  <input aria-label="Search packages" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search package, ecosystem or product…" className="max-w-lg rounded-lg border bg-white px-3 py-2 text-sm"/>
  <div className="flex flex-wrap gap-2" aria-label="Filter packages by lifecycle">{LIFECYCLE_STATES.map(state=><button key={state.value} aria-pressed={selectedStates.includes(state.value)} onClick={()=>setStateParam((selectedStates.includes(state.value)?selectedStates.filter(s=>s!==state.value):[...selectedStates,state.value]).join(","))} className={`rounded px-3 py-1.5 text-sm ${selectedStates.includes(state.value)?"bg-brand-bg text-brand-label":"bg-gray-100 text-muted-foreground"}`}>{state.label} · {packages.filter(p=>(p.lifecycleStates??["unknown"]).includes(state.value)).length}</button>)}{!!selectedStates.length&&<button onClick={()=>setStateParam(null)} className="text-xs text-brand-text hover:underline">Clear lifecycle</button>}</div>
  <p className="text-xs text-muted-foreground">Packages with several observed versions can match more than one lifecycle state.</p>
  <div className="flex flex-wrap gap-2" aria-label="Filter packages by tags">{tags.map(tag=><button key={tag} aria-pressed={selected.includes(tag)} onClick={()=>setTagParam((selected.includes(tag)?selected.filter(t=>t!==tag):[...selected,tag]).join(","))} className={`rounded px-2 py-1 text-xs ${selected.includes(tag)?"bg-brand-bg text-brand-label":"bg-gray-100 text-muted-foreground"}`}>{tag} · {packages.filter(p=>p.tags.includes(tag)).length}</button>)}{!!selected.length&&<button onClick={()=>setTagParam(null)} className="text-xs text-brand-text hover:underline">Clear tags</button>}</div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading packages…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Packages unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  <Card title="Packages" meta={`${rows.length} of ${packages.length}`} flush><div className="overflow-x-auto"><table className="w-full text-left text-sm">
   <thead className="bg-muted text-xs text-muted-foreground"><tr>{["Package","Tags","Versions","Used by","CVE / GHSA IDs","Lifecycle"].map(h=><th key={h} className="px-5 py-3">{h}</th>)}</tr></thead>
   <tbody>{rows.map(p=><tr key={p.id} className="border-b last:border-0"><td className="px-5 py-3"><Link className="text-brand-text hover:underline" href={linkTo(packagePath(p.id))}>{packageName(p.name)}</Link><p className="font-mono text-xs text-muted-foreground">{packageName(p.id)}</p></td><td className="px-5 py-3"><PackageTags tags={p.tags}/></td><td className="px-5 py-3 tabular-nums">{p.versions}</td><td className="max-w-sm px-5 py-3">{p.usedBy?.map(image=><Link key={image.digest} href={linkTo(containerImageHref(image.repository,image.digest))} className="block break-all text-xs text-brand-text hover:underline" title={image.image}>{image.image.split("@")[0]}</Link>)}{p.images>(p.usedBy?.length??0)&&<Link href={linkTo(packagePath(p.id))} className="text-xs text-brand-text hover:underline">{p.usedBy?.length?`+${p.images-p.usedBy.length} more images`:`${p.images} images`}</Link>}</td><td className="px-5 py-3 tabular-nums">{p.vulnerabilities}</td><td className="px-5 py-3"><LifecycleLink value={p.lifecycle}/></td></tr>)}</tbody>
  </table></div>{result.data&&!rows.length&&<p className="px-5 py-6 text-sm text-muted-foreground">{search||selected.length||selectedStates.length?"No packages match the filters.":"No package evidence is available in retained SBOMs."}</p>}</Card>
 </Page>
}
