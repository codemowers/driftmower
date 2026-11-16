"use client"

import {useCallback} from "react"
import {useQuery} from "@/lib/hooks/use-query"
import {useClusterState} from "@/lib/cluster/cluster-state"
import {useSandboxScope} from "@/lib/tenancy/sandbox-context"
import {fetchMcpJSON,toolNames} from "@/browser/connection"
import type {SignalHistory} from "./signals"
import {historyRequest} from "./request"

export function useSignalHistory(signal:"cves"|"serviceaccounts"|"technical_debt",hoursPerUpgrade=1,buildAgeDaysPerUpgrade=365){
 const cluster=useClusterState(s=>s.clusterName)
 const {namespaces}=useSandboxScope()
 const scope=JSON.stringify(namespaces?[...namespaces].sort():null)
 const load=useCallback(async(abort:AbortSignal)=>{
  if(!(await toolNames()).has("query_signal_history"))throw new Error("Historical signal metrics are not configured")
  const selected=JSON.parse(scope) as string[]|null
  if(selected?.length===0)throw new Error("No namespaces selected")
  const params=new URLSearchParams({signal,days:"90",hoursPerUpgrade:String(hoursPerUpgrade),buildAgeDaysPerUpgrade:String(buildAgeDaysPerUpgrade)})
  for(const ns of selected??[])params.append("namespaces",ns)
  return historyRequest(()=>fetchMcpJSON<SignalHistory>(`/api/observability/signal-history?${params}`,{signal:abort}),abort)
 },[signal,scope,hoursPerUpgrade,buildAgeDaysPerUpgrade])
 return useQuery({key:cluster?JSON.stringify([cluster,signal,scope,hoursPerUpgrade,buildAgeDaysPerUpgrade]):null,load,interval:300_000,keepDataOnError:false})
}
