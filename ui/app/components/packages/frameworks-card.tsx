"use client"
import {usePageNotices} from "@/browser/dashboard-notices"
import { useCallback } from "react"
import Link from "next/link"
import Card from "@/app/components/layout/card"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { callTool } from "@/browser/connection"
import { packageName, packagePath, type PackagesResult } from "@/lib/features/packages/types"
import {imageFilePath} from "@/lib/features/packages/sources"
import { PackageTags, LifecycleLink } from "./evidence"

export default function FrameworksCard({namespace,uid}:{namespace:string;uid:string}){
 const cluster=useClusterState(s=>s.clusterName),{linkTo}=useContextHref()
 const load=useCallback((signal:AbortSignal)=>callTool<PackagesResult>("get_packages",{namespace,workloadUID:uid,frameworksOnly:true},signal),[namespace,uid])
 const result=useQuery({key:JSON.stringify([cluster,namespace,uid,"frameworks"]),load,interval:30_000})
 usePageNotices("framework-inventory",result.data?.warnings??[])
 const rows=result.data?.occurrences??[]
 return <Card title="Application frameworks">
  <p className="text-xs text-muted-foreground">Detected package presence and classified roles; execution and direct dependency are unproven. Bundled frontend code may not expose its framework.</p>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading framework evidence…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Framework evidence unavailable: {result.error}</p>}
  {rows.map(o=><div key={`${o.digest}/${o.platformDigest}/${o.purl}`} className="border-b pb-3 last:border-0 last:pb-0"><div className="flex flex-wrap items-center gap-2"><Link href={linkTo(packagePath(o.id))} className="text-sm text-brand-text hover:underline">{packageName(o.name)} <span className="font-mono">{o.version??"unknown version"}</span></Link><PackageTags tags={o.lifecycle?.tags??[]}/></div><p className="break-all font-mono text-xs text-muted-foreground">{o.image}</p><p className="text-xs text-muted-foreground">{o.uses.map(u=>u.container).join(", ")} · {o.coverage}{o.reason?` · ${o.reason}`:""}</p><p className="text-xs"><LifecycleLink value={o.lifecycle}/></p>{o.paths?.map(path=><p key={path} className="break-all font-mono text-xs text-muted-foreground">Path in image: {imageFilePath(path)}</p>)}</div>)}
  {result.data&&!rows.length&&<p className="text-sm text-muted-foreground">Framework unknown from available SBOM and lifecycle metadata.</p>}
  {!!result.data?.coverage.unavailable&&<p className="text-xs text-muted-foreground">Package evidence unavailable for {result.data.coverage.unavailable} images.</p>}
  {result.data?.lifecycle?.stale&&<p className="text-xs text-muted-foreground">Lifecycle classifications are stale.</p>}
  {result.data?.lifecycle?.errors?.map(e=><p key={e} role="alert" className="text-xs text-status-major-label">{e}</p>)}
 </Card>
}
