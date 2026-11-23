import { callTool } from "@/browser/connection"
import type { StatusType } from "@/lib/cluster/reports"
import { HISTORY_SEVERITY } from "@/lib/cluster/styles/status-style"
import type { Observation,SeriesSource } from "./build-series"
import { seriesKey } from "./build-series"
import {historyRequest} from "./request"

export type DriftHistoryData = {
  timeline: number[]
  sources: SeriesSource[]
}
type Series = { metric: Record<string,string>; values?: [number,string][] }

function status(behind: number, version: string, latest: string): StatusType {
 if (behind < 0) return "no_data"
 if (behind === 0) return "up_to_date"
 const a=/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
 const b=/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(latest)
 if (!a||!b) return "behind"
 return Number(b[1])>Number(a[1])?"major_behind":Number(b[2])>Number(a[2])?"minor_behind":"patch_behind"
}
export async function loadDriftHistory(signal?: AbortSignal, namespaces?: string[] | null, item: { workload?: string; kind?: string; image?: string; points?: number } = {}): Promise<DriftHistoryData> {
 const scope=namespaces ? {namespaces,unknown:[],truncated:false} : await callTool<{namespaces:string[];unknown:string[];truncated:boolean}>("list_accessible_namespaces",{},signal)
 if(scope.truncated||scope.unknown.length)throw new Error("Historical namespace coverage is incomplete")
 const selected=[...scope.namespaces].sort()
 const rows:Series[]=[]
 const counts=new Map<string,number>()
 const identity=(m:Record<string,string>,seconds:number)=>JSON.stringify([m.namespace,m.uid,m.image,m.version,m.latest,seconds])
 if(selected.length){
  const history=await historyRequest(()=>callTool<{metrics:Record<string,Series[]>;warnings:string[]}>("query_drift_history",{namespaces:selected,points:100,...item,metrics:["driftmower_version_releases_behind","driftmower_version_status","driftmower_version_container_count"]},signal),signal)
  if(history.warnings?.length)throw new Error(history.warnings.join("; "))
  rows.push(...history.metrics.driftmower_version_releases_behind??[])
  // Explicit unknown observations keep gaps from looking like deleted workloads.
  for(const series of history.metrics.driftmower_version_status??[])if(series.metric.status==="unknown")rows.push({...series,values:series.values?.filter(([,value])=>Number(value)===1).map(([time])=>[time,"-1"])})
  for(const series of history.metrics.driftmower_version_container_count??[])for(const [seconds,count] of series.values??[])counts.set(identity(series.metric,seconds),Number(count))
 }
 const sources=new Map<string,SeriesSource>()
 const timeline=new Set<number>()
 for(const row of rows){
  const m=row.metric
  if(!m.namespace||!m.workload||!m.image)continue
  let image=m.image.split("@")[0]
  const colon=image.lastIndexOf(":")
  if(colon>image.lastIndexOf("/"))image=image.slice(0,colon)
  if(!image.includes("/"))image=`docker.io/library/${image}`
  else if(!/[.:]/.test(image.split("/")[0])&&image.split("/")[0]!=="localhost")image=`docker.io/${image}`
  const [registry,...parts]=image.split("/");const repository=parts.join("/")
  const workloadGroupKey=`${m.kind}/${m.namespace}/${m.workload}`
  const key=seriesKey(workloadGroupKey,registry,repository)
  let source=sources.get(key)
  if(!source){source={key,registry,repository,workloadGroupKey,workloadUid:m.uid,workloadKind:m.kind,workloadName:m.workload,workloadNamespace:m.namespace,observations:[],byDigest:new Map()};sources.set(key,source)}
  for(const [seconds,raw] of row.values??[]){
   const behind=Number(raw);if(!Number.isFinite(behind))continue
   const t=seconds*1000;timeline.add(t)
   const count=counts.get(identity(m,seconds))
   // Missing count coverage is not one container or zero containers.
   if(count===undefined||!Number.isFinite(count))continue
   const observation={t,status:status(behind,m.version,m.latest),deployedTag:m.version||null,latestTag:m.latest||null,containerCount:count}
   source.observations.push(observation)
   const digest=m.image.split("@")[1]
   if(digest){const list=source.byDigest.get(digest)??[];list.push(observation);source.byDigest.set(digest,list)}
  }
 }
 for(const source of sources.values()) {
  source.observations=merge(source.observations)
  for(const [digest,observations] of source.byDigest)source.byDigest.set(digest,merge(observations))
 }
 return {timeline:[...timeline].sort((a,b)=>a-b),sources:[...sources.values()]}
}

function merge(observations:Observation[]):Observation[]{
 const times=new Map<number,Observation>()
 for(const observation of observations){
  const old=times.get(observation.t)
  if(!old){times.set(observation.t,{...observation});continue}
  old.containerCount+=observation.containerCount
  if(HISTORY_SEVERITY[observation.status]>HISTORY_SEVERITY[old.status]){
   old.status=observation.status;old.deployedTag=observation.deployedTag;old.latestTag=observation.latestTag
  }
 }
 return [...times.values()].sort((a,b)=>a.t-b.t)
}
