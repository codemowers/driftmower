import { callTool, selectedEndpoint } from "@/browser/connection"
import { HISTORY_SEVERITY } from "@/lib/cluster/styles/status-style"
import type { StatusType } from "@/lib/cluster/reports"
import type { Observation, SeriesSource } from "./build-series"
import { seriesKey } from "./build-series"
import type { RottennessPoint } from "./types"

export type DriftHistoryData = {
  timeline: number[]
  reportTimes: Map<string, number>
  rottenness: RottennessPoint[]
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
async function load(): Promise<DriftHistoryData> {
 const scope=await callTool<{namespaces:string[];unknown:string[];truncated:boolean}>("list_accessible_namespaces")
 if(scope.truncated||scope.unknown.length)throw new Error("Historical namespace coverage is incomplete")
 const namespaces=scope.namespaces.sort()
 const end=new Date(Math.floor(Date.now()/300_000)*300_000)
 const start=new Date(end.getTime()-90*86400_000)
 const rows:Series[]=[]
 const counts=new Map<string,number>()
 const identity=(m:Record<string,string>,seconds:number)=>JSON.stringify([m.namespace,m.uid,m.image,m.version,m.latest,seconds])
 // Bound fan-out; the MCP service independently authorizes each namespace.
 for (const namespace of namespaces) {
  const result=await callTool<{result:Series[];warnings:string[]}>("query_drift_history",{namespace,metric:"driftmower_version_releases_behind",start:start.toISOString(),end:end.toISOString(),stepSeconds:900,limit:1000})
  if(result.warnings?.length)throw new Error(result.warnings.join("; "))
  rows.push(...result.result)
  const coverage=await callTool<{result:Series[];warnings:string[]}>("query_drift_history",{namespace,metric:"driftmower_version_status",start:start.toISOString(),end:end.toISOString(),stepSeconds:900,limit:1000})
  if(coverage.warnings?.length)throw new Error(coverage.warnings.join("; "))
  // Explicit unknown observations keep gaps from looking like deleted workloads.
  for(const series of coverage.result)if(series.metric.status==="unknown")rows.push({...series,values:series.values?.filter(([,value])=>Number(value)===1).map(([time])=>[time,"-1"])})
  const observed=await callTool<{result:Series[];warnings:string[]}>("query_drift_history",{namespace,metric:"driftmower_version_container_count",start:start.toISOString(),end:end.toISOString(),stepSeconds:900,limit:1000})
  if(observed.warnings?.length)throw new Error(observed.warnings.join("; "))
  for(const series of observed.result)for(const [seconds,count] of series.values??[])counts.set(identity(series.metric,seconds),Number(count))
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
  if(!source){source={key,registry,repository,workloadGroupKey,workloadKind:m.kind,workloadName:m.workload,workloadNamespace:m.namespace,observations:[],byDigest:new Map()};sources.set(key,source)}
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
 return {timeline:[...timeline].sort((a,b)=>a-b),reportTimes:new Map(),rottenness:[],sources:[...sources.values()]}
}
const cache=new Map<string,{expires:number;promise:Promise<DriftHistoryData>}>()
export async function loadDriftHistory(context:string):Promise<DriftHistoryData>{
 const key=`${await selectedEndpoint()}|${context}`
 const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.promise
 const promise=load().catch(error=>{cache.delete(key);throw error})
 cache.set(key,{expires:Date.now()+300_000,promise});return promise
}
export async function refreshDriftHistory(context:string):Promise<DriftHistoryData>{
 cache.delete(`${await selectedEndpoint()}|${context}`);return loadDriftHistory(context)
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
