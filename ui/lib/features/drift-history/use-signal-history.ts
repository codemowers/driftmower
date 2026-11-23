"use client"

import {useCallback} from "react"
import {useQuery} from "@/lib/hooks/use-query"
import {useClusterState} from "@/lib/cluster/cluster-state"
import {useSandboxScope} from "@/lib/tenancy/sandbox-context"
import {fetchMcpJSON,toolNames} from "@/browser/connection"
import type {SignalHistory} from "./signals"
import {historyRequest} from "./request"

function useSignal(signal:"cves"|"serviceaccounts"|"technical_debt"|"drift"|"scan_coverage",hours=168,current=false){
 const cluster=useClusterState(s=>s.clusterName)
 const {namespaces}=useSandboxScope()
 const scope=JSON.stringify(namespaces?[...namespaces].sort():null)
 const load=useCallback(async(abort:AbortSignal)=>{
  if(!(await toolNames()).has("query_signal_history"))throw new Error("Historical signal metrics are not configured")
  const selected=JSON.parse(scope) as string[]|null
  if(selected?.length===0)throw new Error("No namespaces selected")
  const params=new URLSearchParams({signal,hours:String(hours)})
  for(const ns of selected??[])params.append("namespaces",ns)
  if(current)params.set("current","true")
  const request=()=>fetchMcpJSON<SignalHistory>(`/api/observability/signal-history?${params}`,{signal:abort})
  return current?request():historyRequest(request,abort)
 },[signal,scope,hours,current])
 return useQuery({key:cluster?JSON.stringify([cluster,signal,scope,hours,current]):null,load,interval:300_000,keepDataOnError:false})
}

export function useSignalHistory(signal:"cves"|"serviceaccounts"|"technical_debt"|"drift"|"scan_coverage",hours=168){
 return useSignal(signal,hours)
}

export function useCurrentDrift(){
 return useSignal("drift",168,true)
}

export type SignalCapabilities={cves:boolean;serviceaccounts:boolean;scan_coverage?:boolean}
export function useSignalCapabilities(){
 const cluster=useClusterState(state=>state.clusterName)
 const load=useCallback((signal:AbortSignal)=>fetchMcpJSON<SignalCapabilities>("/api/observability/signal-history-capabilities",{signal}),[])
 return useQuery({key:cluster?JSON.stringify([cluster,"signal-history-features"]):null,load,keepDataOnError:false})
}
