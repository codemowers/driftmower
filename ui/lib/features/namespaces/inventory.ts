import type { ClusterResource } from "../../cluster/cluster-state"
import type { Report } from "../../cluster/reports"
import { reportWorkloadRoots } from "../../utils/report-roots.ts"

// A crashing but still-running Pod remains visible. Only terminal phases are
// excluded; missing phase information is not evidence of completion.
export function isTerminalPod(resource:ClusterResource):boolean{
 return resource.kind==="Pod"&&(resource.phase==="Succeeded"||resource.phase==="Failed")
}
export function namespaceWorkloadRoots(data:Report|null,resources:ClusterResource[]|null){
 const pods=(resources??[]).filter(resource=>resource.kind==="Pod")
 return reportWorkloadRoots(data).filter(root=>{
  if(root.kind==="ContainerImage"||root.completed)return false
  if(root.kind==="Pod"){
   const pod=pods.find(p=>p.uid===root.uid||(p.namespace===root.namespace&&p.name===root.name))
   return pod?!isTerminalPod(pod):!(root.usages.length>0&&root.usages.every(usage=>usage.finished))
  }
  return true
 })
}
