import { callTool } from "./connection"
import type { DashboardSnapshot } from "./snapshot"
import type { ImageUsage, ReleaseInfo, ReportWorkload } from "@/lib/cluster/reports"
import { referenceKeys, enrichSnapshot } from "@/lib/features/crawler/enrich"

export type InventoryStatus = Pick<DashboardSnapshot,"clusterContext"|"revision"|"observedAt"|"subscriptionUri"|"prometheusUrl">
export type PodRow = { name:string;namespace:string;uid:string;createdAt:string;nodeName?:string;phase:string;ips?:string[];hasImagePullSecrets:boolean;containers:{name:string;image:string;imageID?:string}[] }
type Inventory<T> = { items?:T[];workloads?:T[];revision:string;warnings?:string[] }

export function inventoryNamespace(path:string):string|undefined {
 const match=/^\/namespaces\/([^/]+)/.exec(path)
 return match?decodeURIComponent(match[1]):undefined
}
export function needsInventory(path:string):boolean {
 return /^\/(executive-summary|topmost-owners|namespaces|container-images|helm-releases|vulnerabilities|advisories|applications|export)(\/|$)/.test(path)
}
async function inventory<T>(tool:string,namespace:string|undefined,cancelled:()=>boolean):Promise<{items:T[];warnings:string[];revision:string}> {
 const result=await callTool<Inventory<T>>(tool,{namespace})
 if(cancelled())throw new Error("Inventory read cancelled")
 return {items:result.items??result.workloads??[],warnings:result.warnings??[],revision:result.revision}
}

// Domain responses contain each Pod and workload once. Only the browser
// creates presentation groups, using shared ImageUsage references.
export function composeInventory(status:InventoryStatus,workloads:ReportWorkload[],pods:PodRow[]):DashboardSnapshot {
 const snapshot:DashboardSnapshot={...status,workloads,imageUsages:[],workloadGroups:{},releaseGroups:{},resources:[],issues:[],drift:{normalizedScore:0,totalContainers:0,containerScores:{},releaseScores:{},workloadScores:{},repoScores:{}}}
 const owners=new Map<string,ReportWorkload>()
 const releases=new Map<string,ReleaseInfo>()
 for(const workload of workloads){
  if(workload.kind==="Namespace")continue
  snapshot.resources.push({...workload})
  for(const pod of workload.pods??[])owners.set(`${workload.namespace}/${pod}`,workload)
  if(workload.helmReleaseName){
   const ns=workload.helmReleaseNamespace||workload.namespace,name=workload.helmReleaseName,key=`helm/${ns}/${name}`
   const chart=workload.helmChart??"",match=/^(.*)-(\d[^]*)$/.exec(chart)
   const release=releases.get(key)??{managementKind:"helm",name,namespace:ns,uid:`helm:${ns}:${name}`,groupKey:key,chartName:match?.[1]??chart,chartVersion:match?.[2]??"",chartAppVersion:""}
   releases.set(key,release)
  }
 }
 for(const pod of pods){
  const owner=owners.get(`${pod.namespace}/${pod.name}`)
  const root={uid:owner?.uid??pod.uid,kind:owner?.kind??"Pod",name:owner?.name??pod.name,namespace:pod.namespace,groupKey:`${owner?.kind??"Pod"}/${pod.namespace}/${owner?.name??pod.name}`}
  snapshot.resources.push({uid:pod.uid,name:pod.name,namespace:pod.namespace,kind:"Pod",createdAt:pod.createdAt,nodeName:pod.nodeName,phase:pod.phase,ips:pod.ips,...(root.uid!==pod.uid?{ownerUID:root.uid}:{})})
  for(const container of pod.containers){
   const canonical=referenceKeys(container.image)[0],name=canonical.split("@")[0].replace(/:[^/]*$/,""),slash=name.indexOf("/")
   const tagRef=container.image.split("@")[0],colon=tagRef.lastIndexOf(":"),tag=colon>tagRef.lastIndexOf("/")?tagRef.slice(colon+1):""
   const running=(container.imageID??"").replace(/^(docker-pullable|containerd|docker):\/\//,"")
   const digest=running.includes("@")?running.split("@")[1]:running.startsWith("sha256:")?running:canonical.split("@")[1]??""
   const usage:ImageUsage={context:status.clusterContext,namespace:pod.namespace,podName:pod.name,uid:pod.uid,containerName:container.name,image:container.image,originalImage:container.image,imageId:running,controllerKind:root.kind,controllerName:root.name,hasImagePullSecrets:pod.hasImagePullSecrets,actualTag:tag,allActualTags:tag?[tag]:[],tagStatus:"known",digestSemver:null,imageInfo:{registry:name.slice(0,slash),repository:name.slice(slash+1),tag,digest,sourceStatus:"unknown"},versionStatus:{statusType:"no_data",deployedTag:tag,latestTag:null,majorDifference:0,minorDifference:0,patchDifference:0},workloadRootInfo:root,releaseInfo:owner?.helmReleaseName?releases.get(`helm/${owner.helmReleaseNamespace||owner.namespace}/${owner.helmReleaseName}`)??null:null,...(["Succeeded","Failed"].includes(pod.phase)?{finished:true}:{})}
   snapshot.imageUsages.push(usage)
  }
 }
 for(const release of releases.values())snapshot.drift.releaseScores[release.groupKey]={groupKey:release.groupKey,releaseInfo:release,normalizedScore:0,distinctRepoCount:0,staleRepoCount:0,totalContainers:0,totalWorkloadCount:workloads.filter(w=>w.helmReleaseName===release.name&&(w.helmReleaseNamespace||w.namespace)===release.namespace).length}
 snapshot.drift.totalContainers=snapshot.imageUsages.filter(u=>!u.finished).length
 return enrichSnapshot(snapshot,[])
}
export async function loadInventory(status:InventoryStatus,namespace:string|undefined,cancelled:()=>boolean):Promise<DashboardSnapshot>{
 const [workloads,pods]=await Promise.all([inventory<ReportWorkload>("get_workloads",namespace,cancelled),inventory<PodRow>("list_pod_inventory",namespace,cancelled)])
 const snapshot=composeInventory({...status,revision:workloads.revision},workloads.items,pods.items)
 snapshot.warnings=[...new Set([...workloads.warnings,...pods.warnings])]
 return snapshot
}
