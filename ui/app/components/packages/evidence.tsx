"use client"
import Link from "next/link"
import {usePageNotices} from "@/browser/dashboard-notices"
import { useContextHref } from "@/lib/hooks/use-context-href"
import type { Lifecycle, PackagesResult } from "@/lib/features/packages/types"

export function PackageTags({tags}:{tags:string[]}){
 const {linkTo}=useContextHref()
 return <span className="inline-flex flex-wrap gap-1">{tags.map(tag=><Link key={tag} href={linkTo(`/packages?tags=${encodeURIComponent(tag)}`)} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-muted-foreground hover:underline">{tag}</Link>)}</span>
}
export function LifecycleLink({value}:{value?:Lifecycle}){
 if(value&&!value.url)return <span>{value.label} · lifecycle unknown</span>
 if(!value)return <span className="text-muted-foreground">Unknown</span>
 return <a href={value.url} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">{value.label}{value.cycle?` ${value.cycle} · ${value.state.replaceAll("-"," ")}`:""}{value.eol?` · ${value.eol}`:""}</a>
}
export function PackageCoverage({data}:{data?:PackagesResult}){
 usePageNotices("package-inventory",data?.warnings??[])
 if(!data)return null
 const c=data.coverage
 return <div className="flex flex-col gap-1 text-xs text-muted-foreground">
  <p>{c.scanned} of {c.images} running images have retained package evidence · {c.partial} partial · {c.unavailable} unavailable{c.unresolvedContainers?` · ${c.unresolvedContainers} containers without resolved image identity`:""}. Missing evidence is unknown. Partial scans may exclude Java archives.</p>
  <p>Lifecycle metadata: {data.lifecycle?.checkedAt?new Date(data.lifecycle.checkedAt).toLocaleString():"unavailable"}{data.lifecycle?.stale?" · stale":""}. Refresh interval: 14 days. Upstream support status is separate from distribution backports.</p>
  {data.lifecycle?.errors?.map(error=><p key={error} role="alert" className="text-status-major-label">Lifecycle metadata: {error}</p>)}

 </div>
}
