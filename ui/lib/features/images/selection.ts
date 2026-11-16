import type { ImageUsage } from "../../cluster/reports"

// Detail routes select only the requested artifact, regardless of UI focus tabs.
export function selectedImageUsages(pathname:string,usages:ImageUsage[]):ImageUsage[]{
 const artifact=/^\/topmost-owners\/([^/]+)\/images\/([^/]+)\/?$/.exec(pathname)
 if(artifact){const owner=decodeURIComponent(artifact[1]),digest=decodeURIComponent(artifact[2]);return usages.filter(u=>u.workloadRootInfo?.uid===owner&&u.imageInfo.digest===digest)}
 if(pathname.startsWith("/container-images/")){const repository=decodeURIComponent(pathname.slice("/container-images/".length)).replace(/\/$/,"");return usages.filter(u=>`${u.imageInfo.registry}/${u.imageInfo.repository}`===repository)}
 return /^\/vulnerabilities(?:\/|$)/.test(pathname)?usages:[]
}
