"use client"

import TimeSeriesChart from "@/app/components/time-series-chart"
import {ChartTooltipContent} from "@/components/ui/chart"
import {useSignalHistory} from "@/lib/features/drift-history/use-signal-history"
import {currentSignal,signalPoints} from "@/lib/features/drift-history/signals"
import {useCallback} from "react"
import {useQuery} from "@/lib/hooks/use-query"
import {useClusterState} from "@/lib/cluster/cluster-state"
import {fetchMcpJSON} from "@/browser/connection"

const definitions={
 cves:{title:"Vulnerability history",unit:"findings in running images",keys:["critical","high"],labels:["Critical","High"],caption:"Counts vulnerability/component findings per running image digest. The same CVE in different images can count more than once."},
 serviceaccounts:{title:"Service-account exposure history",unit:"active service accounts",keys:["cluster_admin","broad_permissions"],labels:["Cluster admin","Other broad permissions"],caption:"Distinct identities assigned to active Pods. Permission grants do not prove compromise or a mounted token."},
}
function SecurityHistoryCard({signal}:{signal:"cves"|"serviceaccounts"}){
 const result=useSignalHistory(signal)
 const definition=definitions[signal]
 const config=Object.fromEntries(definition.keys.map((key,i)=>[key,{label:definition.labels[i],color:i===0?"var(--color-status-major)":signal==="cves"?"var(--color-status-patch)":"var(--color-status-minor)"}]))
 const hasSamples=result.data?.series.some(series=>definition.keys.includes(series.name)&&series.values.length>0)
 const missing=currentSignal(result.data,"unscanned_images")
 const unresolved=currentSignal(result.data,"unresolved_containers")
 return <section className="min-w-0 rounded-xl border border-gray-200 bg-white p-6">
  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{definition.title}</h2>
  <div className="my-4 flex flex-wrap gap-5">{definition.keys.map((key,i)=><div key={key}><p className="text-xs text-muted-foreground">{definition.labels[i]}</p><p className={`text-2xl font-semibold tabular-nums ${i===0?"text-status-major-label":signal==="cves"?"text-status-patch-label":"text-status-minor-label"}`}>{currentSignal(result.data,key)?.toLocaleString()??"—"}</p></div>)}</div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading history…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">History unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  {result.data&&!hasSamples&&<p className="text-sm text-muted-foreground">No historical samples yet. Missing data is unknown.</p>}
  {result.data&&hasSamples&&<TimeSeriesChart data={signalPoints(result.data,definition.keys)} config={config} axes domain={[0,"auto"]} className="h-56" axisFormatter={time=>new Date(time).toLocaleDateString(undefined,{month:"short",day:"numeric"})} series={definition.keys.map(key=>({key,name:key,fill:signal==="cves"?config[key].color:"transparent",stroke:config[key].color,stack:signal==="cves"?"cves":undefined,curve:"stepAfter"}))} tooltip={<ChartTooltipContent labelFormatter={(_,payload)=>new Date(payload?.[0]?.payload?.t??0).toLocaleString()}/>}/>}
  <p className="mt-3 text-xs text-muted-foreground">90 days · {definition.unit} · gaps mean unavailable data.</p>
  {signal==="cves"&&<p className="mt-2 text-xs text-muted-foreground">{missing===null||unresolved===null?"Scan coverage is unavailable.":`${missing} running image digests lack a usable scan; ${unresolved} running containers have unresolved image digests.`}</p>}
  <p className="mt-2 text-xs text-muted-foreground">{definition.caption}</p>
  {result.data?.warnings.map(warning=><p key={warning} className="mt-2 text-xs text-status-minor-label">{warning}</p>)}
 </section>
}
export default function SecurityHistory(){
 const cluster=useClusterState(state=>state.clusterName)
 const load=useCallback((signal:AbortSignal)=>fetchMcpJSON<{cves:boolean;serviceaccounts:boolean}>("/api/observability/signal-history-capabilities",{signal}),[])
 const features=useQuery({key:cluster?JSON.stringify([cluster,"signal-history-features"]):null,load,interval:30_000,keepDataOnError:false})
 if(features.error)return <p role="alert" className="text-sm text-muted-foreground">Security history configuration unavailable: {features.error}</p>
 if(!features.data?.cves&&!features.data?.serviceaccounts)return null
 return <div className={`grid min-w-0 grid-cols-1 gap-5 ${features.data.cves&&features.data.serviceaccounts?"xl:grid-cols-2":""}`}>{features.data.cves&&<SecurityHistoryCard signal="cves"/>}{features.data.serviceaccounts&&<SecurityHistoryCard signal="serviceaccounts"/>}</div>
}
