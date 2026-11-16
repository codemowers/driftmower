"use client"

import {useCallback,useState} from "react"
import {useQuery} from "@/lib/hooks/use-query"
import {useClusterState} from "@/lib/cluster/cluster-state"
import {useSandboxScope} from "@/lib/tenancy/sandbox-context"
import {useContextHref} from "@/lib/hooks/use-context-href"
import {fetchMcpJSON,toolNames} from "@/browser/connection"
import {alertActions,alertHref,type FiringAlert} from "@/lib/features/actions/alerts"
import PrefetchLink from "@/app/components/prefetch-link"

const colors:Record<string,string>={critical:"bg-status-major-bg text-status-major-label",warning:"bg-status-minor-bg text-status-minor-label",info:"bg-brand-bg text-brand-label"}
export default function ActionItems(){
 const cluster=useClusterState(s=>s.clusterName)
 const {namespaces}=useSandboxScope(),{linkTo}=useContextHref()
 const [expanded,setExpanded]=useState(false)
 const load=useCallback(async(signal:AbortSignal)=>{
  if(!(await toolNames()).has("list_alerts"))throw new Error("Alertmanager is not configured")
  return fetchMcpJSON<{alerts:FiringAlert[]}>("/api/observability/alerts",{signal})
 },[])
 const result=useQuery({key:cluster?JSON.stringify([cluster,"action-items"]):null,load,interval:30_000,keepDataOnError:false})
 const actions=alertActions(result.data?.alerts??[],namespaces)
 const shown=expanded?actions:actions.slice(0,5)
 return <section className="rounded-xl border border-gray-200 bg-white p-6">
  <div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Action items</h2><span className="text-xs text-muted-foreground">{result.data?`${actions.length} affected resources`:"Firing alerts"}</span></div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading firing alerts…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Action items unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  {result.data&&!actions.length&&<p className="text-sm text-muted-foreground">No unsilenced firing alerts in this scope. This does not establish complete security coverage.</p>}
  <div className="divide-y divide-gray-100">{shown.map(action=>{
   const first=action.alerts[0]
   return <div key={action.key} className="py-4 first:pt-0 last:pb-0"><div className="flex items-start gap-3"><span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[first.severity]??"bg-muted text-muted-foreground"}`}>{first.severity||"other"}</span><div className="min-w-0 flex-1"><PrefetchLink href={linkTo(alertHref(first))} className="text-sm font-semibold hover:underline">{first.summary||first.alertname}</PrefetchLink><p className="mt-1 text-xs text-muted-foreground">{first.namespace??"Cluster-wide"} · {action.alerts.length} firing {action.alerts.length===1?"signal":"signals"}</p><details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Evidence and next steps</summary>{action.alerts.map(alert=><div key={alert.fingerprint} className="mt-3"><p className="font-medium">{alert.alertname}</p><p className="mt-1 whitespace-pre-line text-muted-foreground">{alert.description||alert.summary||"No description supplied by the alert rule."}</p></div>)}</details></div></div></div>
  })}</div>
  {actions.length>5&&<button onClick={()=>setExpanded(!expanded)} className="mt-4 text-xs text-muted-foreground hover:underline">{expanded?"Show five highest priority items":`Show ${actions.length-5} more`}</button>}
 </section>
}
