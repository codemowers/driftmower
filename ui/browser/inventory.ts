import { callTool } from "./connection"
import type { DashboardSnapshot } from "./snapshot"
import type { ImageUsage, ReleaseInfo, ReportWorkload } from "@/lib/cluster/reports"
import { referenceKeys, enrichSnapshot } from "@/lib/features/crawler/enrich"

export type InventoryStatus = Pick<DashboardSnapshot,"clusterContext"|"revision"|"observedAt"|"subscriptionUri"|"prometheusUrl"|"missingComponents">
export type PodRow = { scanPod?:boolean; jobOwned?:boolean; issues?:import("@/lib/cluster/issues").WorkloadIssue[]; terminating?:boolean; security?:import("@/lib/cluster/pod-security").PodSecurity; priorityClassName?:string;priority?:number; name:string;namespace:string;uid:string;createdAt:string;nodeName?:string;phase:string;ips?:string[];hasImagePullSecrets:boolean;containers:{name:string;image:string;imageID?:string}[] }

export function inventoryNamespace(path:string):string|undefined {
 const match=/^\/namespaces\/([^/]+)/.exec(path)
 return match?decodeURIComponent(match[1]):undefined
}
export function needsInventory(path:string):boolean {
 return /^\/(topmost-owners|namespaces|container-images|helm-releases|vulnerabilities|advisories|applications|export)(\/|$)/.test(path)||/^\/source-repositories\/./.test(path)
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
  const apiGroup=owner?.apiVersion?.includes("/")?owner.apiVersion.split("/")[0]:undefined
  const root={apiGroup,qualifiedKind:apiGroup?`${owner!.kind}.${apiGroup}`:owner?.kind??"Pod",uid:owner?.uid??pod.uid,kind:owner?.kind??"Pod",name:owner?.name??pod.name,namespace:pod.namespace,groupKey:`${owner?.kind??"Pod"}/${pod.namespace}/${owner?.name??pod.name}`}
  snapshot.resources.push({uid:pod.uid,name:pod.name,namespace:pod.namespace,kind:"Pod",scanPod:pod.scanPod,security:pod.security,issues:pod.issues,jobOwned:pod.jobOwned,terminating:pod.terminating,priorityClassName:pod.priorityClassName,priority:pod.priority,createdAt:pod.createdAt,nodeName:pod.nodeName,phase:pod.phase,ips:pod.ips,...(root.uid!==pod.uid?{ownerUID:root.uid}:{})})
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
export type InventoryQuery = { namespace?: string; includeFinished: boolean; includeOrphans: boolean }

// What a route needs from get_workloads: one namespace on namespace pages,
// orphans only where they are shown, finished Pods only when asked for.
export function inventoryQuery(path:string,search:URLSearchParams):InventoryQuery|null {
 if(!needsInventory(path))return null
 return {
  namespace:inventoryNamespace(path),
  includeFinished:(search.get("filters")??"").split(",").some(token=>token==="showfinished"||token==="showscanpods"),
  includeOrphans:/^\/namespaces\/[^/]+/.test(path)||/^\/topmost-owners\/namespace(:|%3A)/i.test(path),
 }
}

type PodFacts = Pick<PodRow,"phase"|"nodeName"|"security"|"priorityClassName"|"priority"|"hasImagePullSecrets">
type TreePod = Omit<PodRow,"namespace"|keyof PodFacts> & Partial<PodFacts>
type TreeOwner = Omit<ReportWorkload,"pods"> & Partial<PodFacts> & { scanPod?:boolean; ips?:string[]; containers?:PodRow["containers"]; createdAt?:string; pods?:TreePod[] }
type InventoryTree = { owners:TreeOwner[]; orphans?:ReportWorkload[]; warnings?:string[]; revision:string }

// Pods inherit the facts their owner holds for all of them.
function podRow(owner:TreeOwner,pod:TreePod):PodRow {
 return {phase:owner.phase??"",nodeName:owner.nodeName,security:owner.security,priorityClassName:owner.priorityClassName,priority:owner.priority,hasImagePullSecrets:owner.hasImagePullSecrets??false,...pod,namespace:owner.namespace} as PodRow
}

export function flattenInventory(tree:InventoryTree):{workloads:ReportWorkload[];pods:PodRow[]} {
 const workloads:ReportWorkload[]=[],pods:PodRow[]=[]
 const buckets=new Map<string,ReportWorkload>()
 for(const orphan of tree.orphans??[]){const bucket={...orphan,standalonePods:[]};buckets.set(orphan.namespace,bucket);workloads.push(bucket)}
 for(const owner of tree.owners){
  if(owner.kind==="Pod"){
   pods.push(podRow(owner,{name:owner.name,uid:owner.uid,createdAt:owner.createdAt??"",ips:owner.ips,containers:owner.containers??[],issues:owner.issues,scanPod:owner.scanPod}))
   let bucket=buckets.get(owner.namespace)
   if(!bucket){bucket={kind:"Namespace",name:"orphaned-workloads",namespace:owner.namespace,apiVersion:"v1",uid:`namespace:${owner.namespace}`,standalonePods:[]} as ReportWorkload;buckets.set(owner.namespace,bucket);workloads.push(bucket)}
   bucket.standalonePods!.push({name:owner.name,uid:owner.uid,issues:owner.issues})
   continue
  }
  const {pods:children=[],...workload}=owner
  workloads.push({...workload,pods:children.map(p=>p.name)} as ReportWorkload)
  for(const child of children)pods.push(podRow(owner,child))
 }
 return {workloads,pods}
}

export async function loadInventory(status:InventoryStatus,query:InventoryQuery,cancelled:()=>boolean):Promise<DashboardSnapshot>{
 const tree=await callTool<InventoryTree>("get_workloads",query)
 if(cancelled())throw new Error("Inventory read cancelled")
 const {workloads,pods}=flattenInventory(tree)
 const snapshot=composeInventory({...status,revision:tree.revision},workloads,pods)
 snapshot.warnings=[...new Set(tree.warnings??[])]
 return snapshot
}
