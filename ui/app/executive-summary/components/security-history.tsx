"use client"
import Card from "@/app/components/layout/card"

import TimeSeriesChart from "@/app/components/time-series-chart"
import {ChartTooltipContent} from "@/components/ui/chart"
import {summaryAxisTime} from "@/lib/features/drift-history/time-window"
import {useSignalHistory, type useSignalCapabilities} from "@/lib/features/drift-history/use-signal-history"
import {currentSignal,signalPoints} from "@/lib/features/drift-history/signals"

const definitions={
 cves:{title:"Vulnerability history",unit:"findings in running images",keys:["critical","high"],labels:["Critical","High"],caption:"Counts vulnerability/component findings per running image digest. The same CVE in different images can count more than once."},
 serviceaccounts:{title:"Service-account exposure history",unit:"active service accounts",keys:["cluster_admin","broad_permissions"],labels:["Cluster admin","Other broad permissions"],caption:"Distinct identities assigned to active Pods. Permission grants do not prove compromise or a mounted token."},
}
function SecurityHistoryCard({signal,hours}:{signal:"cves"|"serviceaccounts";hours:number}){
 const result=useSignalHistory(signal,hours)
 const definition=definitions[signal]
 const config=Object.fromEntries(definition.keys.map((key,i)=>[key,{label:definition.labels[i],color:signal==="cves" ? (i===0?"var(--color-status-major)":"var(--color-status-patch)") : i===0?"var(--color-status-major)":"var(--color-status-minor)"}]))
 const hasSamples=result.data?.series.some(series=>definition.keys.includes(series.name)&&series.values.length>0)
 const missing=currentSignal(result.data,"unscanned_images")
 const unresolved=currentSignal(result.data,"unresolved_containers")
 return <Card title={definition.title}>
  <div className="flex flex-wrap gap-5">{definition.keys.map((key,i)=><div key={key}><p className="text-xs text-muted-foreground">{definition.labels[i]}</p><p className={`text-2xl font-semibold tabular-nums ${i===0?"text-status-major-label":signal==="cves"?"text-status-patch-label":"text-status-minor-label"}`}>{currentSignal(result.data,key)?.toLocaleString()??"—"}</p></div>)}</div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading history…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">History unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  {result.data&&!hasSamples&&<p className="text-sm text-muted-foreground">No historical samples yet. Missing data is unknown.</p>}
  {result.data&&hasSamples&&<TimeSeriesChart data={signalPoints(result.data,definition.keys)} config={config} axes domain={[0,"auto"]} className="h-56" axisFormatter={time=>summaryAxisTime(time,hours)} series={definition.keys.map(key=>({key,name:key,fill:signal==="cves"?config[key].color:"transparent",stroke:config[key].color,stack:signal==="cves"?"cves":undefined,curve:"stepAfter"}))} tooltip={<ChartTooltipContent labelFormatter={(_,payload)=>new Date(payload?.[0]?.payload?.t??0).toLocaleString()}/>}/>}
  <p className="text-xs text-muted-foreground">{definition.unit} · gaps mean unavailable data.</p>
  {signal==="cves"&&<p className="mt-2 text-xs text-muted-foreground">{missing===null||unresolved===null?"Scan coverage is unavailable.":`${missing} running image digests lack a usable scan; ${unresolved} running containers have unresolved image digests.`}</p>}
  <p className="mt-2 text-xs text-muted-foreground">{definition.caption}</p>
  {result.data?.warnings.map(warning=><p key={warning} className="mt-2 text-xs text-status-minor-label">{warning}</p>)}
 </Card>
}
export default function SecurityHistory({hours,features}:{hours:number;features:ReturnType<typeof useSignalCapabilities>}){
 if(features.error)return <p role="alert" className="text-sm text-muted-foreground">Security history configuration unavailable: {features.error}</p>
 if(!features.data?.cves&&!features.data?.serviceaccounts)return null
 return <div className={`grid min-w-0 grid-cols-1 gap-6 ${features.data.cves&&features.data.serviceaccounts?"xl:grid-cols-2":""}`}>{features.data.cves&&<SecurityHistoryCard signal="cves" hours={hours}/>}{features.data.serviceaccounts&&<SecurityHistoryCard signal="serviceaccounts" hours={hours}/>}</div>
}
