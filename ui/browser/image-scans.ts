import { callTool } from "./connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { cyclonedxReport, type CycloneDX } from "@/lib/features/vulnerability/cyclonedx"
import type { Report } from "@/lib/cluster/reports"

type ScanResult={artifacts:{status:string;bom?:CycloneDX}[]}
const inFlight=new Map<string,Promise<ScanResult>>()
const completed=new Map<string,{result:ScanResult;expires:number}>()

function scanKey(image:string,digest:string){return `${useClusterState.getState().clusterName}/${image}/${digest}`}
async function readScan(input:{image:string;digest:string}):Promise<ScanResult>{
 const key=scanKey(input.image,input.digest),cached=completed.get(key)
 if(cached&&cached.expires>Date.now())return cached.result
 let pending=inFlight.get(key)
 if(!pending){pending=callTool<ScanResult>("get_image_scan",input).then(result=>{
  if(result.artifacts.length>0&&result.artifacts.every(a=>(a.status==="complete"||a.status==="partial")&&a.bom))completed.set(key,{result,expires:Date.now()+60_000})
  return result
 }).finally(()=>inFlight.delete(key));inFlight.set(key,pending)}
 return pending
}

export async function loadImageScans(usages: Report["report"]["imageUsages"],cancelled:()=>boolean) {
 useClusterState.setState({vulnerabilityReports:useClusterState.getState().vulnerabilityReports??{},vulnerabilityReportsError:null})
 const missing=[...new Set(usages.filter(u=>!u.finished&&!u.imageInfo.containerImage).map(u=>u.imageInfo.digest).filter(d=>/^sha256:[a-f0-9]{64}$/.test(d)))]
 for(let offset=0;offset<missing.length&&!cancelled();offset+=100){
  const resolved=await callTool<{images:Record<string,{containerImage:string}>;warnings?:string[]}>("resolve_container_images",{digests:missing.slice(offset,offset+100)})
  for(const usage of usages){const found=resolved.images[usage.imageInfo.digest];if(found)usage.imageInfo.containerImage=found.containerImage}
  if(resolved.warnings?.length)useClusterState.setState({vulnerabilityReportsError:resolved.warnings.join(" ")})
 }
 if(cancelled())return
 const images=new Map<string,{image:string;digest:string}>()
 for(const usage of usages){if(usage.finished)continue;if(!usage.imageInfo.containerImage||!usage.imageInfo.digest){useClusterState.setState(state=>({imageScanStatuses:{...state.imageScanStatuses,[usage.imageInfo.digest]:"unavailable"}}));continue};const image=usage.imageInfo?.containerImage;const digest=usage.imageInfo?.digest;if(image&&digest)images.set(image+"/"+digest,{image,digest})}
 const queue=[...images.entries()]
 useClusterState.setState({vulnerabilityReports:useClusterState.getState().vulnerabilityReports??{},vulnerabilityReportsError:null})
 await Promise.all(Array.from({length:4},async()=>{
  while(queue.length&&!cancelled()){
   const [,input]=queue.shift()!
   useClusterState.setState(state=>({imageScanStatuses:{...state.imageScanStatuses,[input.digest]:"loading"}}))
   try{
    const result=await readScan(input)
    if(cancelled())return
    const boms=result.artifacts.flatMap(a=>(a.status==="complete"||a.status==="partial")&&a.bom?[a.bom]:[])
    const allComplete=result.artifacts.length>0&&result.artifacts.every(a=>a.status==="complete"&&a.bom)
    const status=allComplete?"complete":boms.length?"partial":result.artifacts.some(a=>a.status==="expired")?"expired":result.artifacts.some(a=>a.status==="unavailable"||a.status==="invalid")?"unavailable":"pending"
    useClusterState.setState(state=>({imageScanStatuses:{...state.imageScanStatuses,[input.digest]:status},...(boms.length?{vulnerabilityReports:{...state.vulnerabilityReports,[input.digest]:cyclonedxReport(boms,input.digest)}}:{})}))
   }catch(error){
    if(cancelled())return
    useClusterState.setState(state=>({imageScanStatuses:{...state.imageScanStatuses,[input.digest]:"unavailable"},vulnerabilityReportsError:(error as Error).message}))
   }
  }
 }))
}

// Saves the CycloneDX SBOMs of one image digest as a JSON file: one document,
// or an array of them for an index with several scanned platforms.
export async function downloadSbom(image: string, digest: string): Promise<void> {
 const result=await readScan({image,digest})
 const boms=result.artifacts.flatMap(a=>(a.status==="complete"||a.status==="partial")&&a.bom?[a.bom]:[])
 if(!boms.length)throw new Error("No completed SBOM is cached for this image")
 const blob=new Blob([JSON.stringify(boms.length===1?boms[0]:boms,null,2)],{type:"application/vnd.cyclonedx+json"})
 const link=document.createElement("a")
 link.href=URL.createObjectURL(blob)
 link.download=`${digest.replace(":","-")}.cdx.json`
 link.click()
 setTimeout(()=>URL.revokeObjectURL(link.href),10_000)
}
