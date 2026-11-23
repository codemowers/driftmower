"use client"

import {useCallback} from "react"
import {fetchMcpJSON,toolNames} from "@/browser/connection"
import {useQuery} from "@/lib/hooks/use-query"
import {useClusterState} from "@/lib/cluster/cluster-state"
import {imageScanBadge,type ScanStatus} from "@/lib/features/images/scan-status"

export function useImageScanStatuses(digests:string[]){
 const cluster=useClusterState(s=>s.clusterName)
 const selected=JSON.stringify([...new Set(digests.filter(digest=>/^sha256:[a-f0-9]{64}$/.test(digest)))].sort())
 const load=useCallback(async(signal:AbortSignal)=>{
  if(!(await toolNames()).has("get_image_scan_statuses"))throw new Error("Scan status metadata is not available from this MCP server")
  const digests=JSON.parse(selected) as string[]
  const path="/api/observability/image-scan-statuses"
  const result=digests.length<=50
   ?await fetchMcpJSON<{images:Record<string,ScanStatus>}>(`${path}?${new URLSearchParams(digests.map(d=>["digests",d]))}`,{signal})
   :await fetchMcpJSON<{images:Record<string,ScanStatus>}>(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({digests}),signal})
  return result.images
 },[selected])
 return useQuery({key:cluster&&selected!=="[]"?JSON.stringify([cluster,"scan-statuses",selected]):null,load,interval:30_000,keepDataOnError:false})
}
const colors:Record<string,string>={done:"bg-status-ok-bg text-status-ok-label",failed:"bg-status-major-bg text-status-major-label",pending:"bg-status-patch-bg text-status-patch-label",running:"bg-brand-bg text-brand-label",partial:"bg-status-minor-bg text-status-minor-label",unavailable:"bg-muted text-muted-foreground"}
const labels:Record<string,string>={done:"Done",failed:"Failed",pending:"Pending",running:"Scanning",partial:"Partial",unavailable:"Unavailable"}
export default function ScanStatusBadge({digests,statuses,error,loading}:{digests:string[];statuses?:Record<string,ScanStatus>;error?:string;loading:boolean}){
 if(loading)return <span className="text-xs text-muted-foreground">Loading…</span>
 const badge=imageScanBadge(digests,statuses??{})
 const status=error?"unavailable":badge.status
 return <span className={`relative z-10 inline-flex w-fit rounded px-2 py-0.5 text-xs font-medium ${colors[status]}`} title={error??badge.title}>{labels[status]}{badge.total>1&&status!=="unavailable"?` · ${badge.done}/${badge.total} digests`:""}</span>
}
