"use client"
import { useCallback } from "react"
import Card from "@/app/components/layout/card"
import PrefetchLink from "@/app/components/prefetch-link"
import { callTool } from "@/browser/connection"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { BAND_STYLE } from "@/lib/features/drift-history/band-style"

type Entry = {uid:string;kind:string;name:string;namespace:string;currentTag:string;latestTag:string;class:"major"|"minor"|"patch"|"behind";releasesBehind:number}
type Result = { available:boolean;entries:Entry[];warnings:string[] }
export default function MostOutdatedWorkloads() {
  const cluster=useClusterState(s=>s.clusterName)
  const { namespaces }=useSandboxScope()
  const {linkTo}=useContextHref()
  const scope=JSON.stringify(namespaces?[...namespaces].sort():null)
  const load=useCallback(async(signal:AbortSignal)=>{
    let selected=JSON.parse(scope) as string[]|null
    if(selected===null){const accessible=await callTool<{namespaces:string[];unknown:string[];truncated:boolean}>("list_accessible_namespaces",{},signal);if(accessible.truncated||accessible.unknown.length)throw new Error("Namespace coverage is incomplete");selected=accessible.namespaces}
    if(!selected.length)return {available:false,entries:[],warnings:[]}
    return callTool<Result>("query_outdated_workloads",{namespaces:selected},signal)
  },[scope])
  const result=useQuery({key:cluster?JSON.stringify([cluster,"outdated-workloads",scope]):null,load,interval:300_000,keepDataOnError:false})
  return <Card flush title="Most outdated workloads" meta="top 5 · releases behind">
    {result.error ? <p role="alert" className="px-5 py-4 text-sm text-status-major-label">Workload drift unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>
      : !result.data ? <p className="px-5 py-4 text-sm text-muted-foreground">Reading current workload drift…</p>
      : !result.data.entries.length ? <p className="px-5 py-4 text-sm text-muted-foreground">{result.data.available ? "No workloads with a known version comparison are behind." : "Current workload drift observations are unavailable."}</p>
      : <div className="divide-y">{result.data.entries.map(e=>{
        const status=e.class==="behind"?"behind":`${e.class}_behind` as "major_behind"|"minor_behind"|"patch_behind"
        const style=BAND_STYLE[status]
        return <PrefetchLink key={`${e.namespace}/${e.uid}`} href={linkTo(`/topmost-owners/${e.uid}`)} className="flex items-center gap-4 px-5 py-3 hover:bg-brand-bg/30">
          <div className="min-w-0 flex-1"><p className="truncate font-semibold">{e.name}</p><p className="font-mono text-xs text-muted-foreground">{e.namespace} · {e.kind}</p></div>
          <div className="shrink-0 text-right text-sm"><p>{e.currentTag || "—"}{e.latestTag && e.latestTag!==e.currentTag && <> → {e.latestTag}</>}</p><p className="text-xs text-muted-foreground">{e.releasesBehind} release{e.releasesBehind===1?"":"s"} behind</p></div>
          <span className={`rounded px-2 py-1 text-xs ${style.bg}`}>{style.label}</span>
        </PrefetchLink>
      })}</div>}
    {result.data?.warnings.map(w=><p key={w} className="px-5 py-2 text-xs text-status-minor-label">{w}</p>)}
  </Card>
}
