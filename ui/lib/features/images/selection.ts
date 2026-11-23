import type { ImageUsage } from "../../cluster/reports"

// Findings select only the running images displayed by the resource or artifact.
export function selectedImageUsages(pathname:string,usages:ImageUsage[]):ImageUsage[]{
 const artifact=/^\/topmost-owners\/([^/]+)\/images\/([^/]+)\/?$/.exec(pathname)
 if(artifact){const owner=decodeURIComponent(artifact[1]),digest=decodeURIComponent(artifact[2]);return usages.filter(u=>u.workloadRootInfo?.uid===owner&&u.imageInfo.digest===digest)}
 if(pathname.startsWith("/container-images/")){const repository=decodeURIComponent(pathname.slice("/container-images/".length).split("/-/")[0]).replace(/\/$/,"");return usages.filter(u=>`${u.imageInfo.registry}/${u.imageInfo.repository}`===repository)}
 const namespace=/^\/namespaces\/([^/]+)\/?$/.exec(pathname)
 if(namespace)return usages.filter(u=>u.namespace===decodeURIComponent(namespace[1])&&!u.finished)
 const resource=/^\/topmost-owners\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
 if(resource&&!["logs","network-topology"].includes(resource[2]??"")){
  const owner=decodeURIComponent(resource[1]),pod=resource[2]?decodeURIComponent(resource[2]):undefined
  return usages.filter(u=>!u.finished&&u.workloadRootInfo?.uid===owner&&(!pod||u.uid===pod))
 }
 return /^\/vulnerabilities(?:\/|$)/.test(pathname)?usages:[]
}

// Issue views need declared build timestamps, but do not fetch SBOMs merely
// to classify age. Keep their metadata scope separate from scan detail reads.
export function selectedImageMetadataUsages(pathname:string,usages:ImageUsage[]):ImageUsage[]{
 const workload=/^\/topmost-owners\/([^/]+)(?:\/([^/]+))?/.exec(pathname)
 if(workload){
  if(workload[2]==="images")return selectedImageUsages(pathname,usages)
  const owner=decodeURIComponent(workload[1]),pod=workload[2]?decodeURIComponent(workload[2]):undefined
  return usages.filter(u=>u.workloadRootInfo?.uid===owner&&(!pod||u.uid===pod))
 }
 if(["/topmost-owners","/topmost-owners/","/container-images","/container-images/"].includes(pathname))return usages.filter(u=>!u.finished)
 const namespace=/^\/namespaces\/([^/]+)/.exec(pathname)
 if(namespace)return usages.filter(u=>u.namespace===decodeURIComponent(namespace[1])&&!u.finished)
 return selectedImageUsages(pathname,usages)
}
