"use client"
import { ChromeProfilePrompt } from "./chrome-profile-prompt"
import { loadCrawlerFindings } from "./crawler"
import { useEffect, useState, lazy, Suspense } from "react"
import { LoaderCircle } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import NavBar from "@/app/components/core/nav-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxContext } from "@/lib/tenancy/sandbox-context"
import { presentationData } from "./snapshot"
import { useFeatureFlags } from "@/app/components/feature-flags-init"
import { callTool, toolNames, subscribeDashboard, deploymentConfig, endpoints, finishLogin, loginToEndpoint, connectionProgress, restoreConnectionProgress, useConnectionProgress, selectedEndpoint, user, contextTitle } from "./connection"
import { Params, usePathname, navigate } from "./navigation"
import { selectedImageUsages } from "@/lib/features/images/selection"
import { loadImageScans } from "./image-scans"
import { loadInventory, needsInventory, inventoryNamespace, type InventoryStatus } from "./inventory"
import SettingsPage, { SettingsContext } from "./settings"
import DashboardNotices from "./dashboard-notices"
import type { SessionClaims } from "@/lib/auth/types"

const routes = [
  {pattern: new RegExp("^/vulnerabilities/([^/]+)/?$"), names: ["id"], Page: lazy(() => import("@/app/vulnerabilities/[id]/page"))},
  {pattern: new RegExp("^/source-repositories/([^/]+)/?$"), names: ["source"], Page: lazy(() => import("@/app/source-repositories/[source]/page"))},
  {pattern: new RegExp("^/source-repositories/?$"), names: [], Page: lazy(() => import("@/app/source-repositories/page"))},
  {pattern: new RegExp("^/volumes/pvc/([^/]+)/([^/]+)/?$"), names: ["namespace", "name"], Page: lazy(() => import("@/app/volumes/pvc/[namespace]/[name]/page"))},
  {pattern: new RegExp("^/volumes/pv/([^/]+)/?$"), names: ["name"], Page: lazy(() => import("@/app/volumes/pv/[name]/page"))},
  {pattern: new RegExp("^/base-images/(.+)/?$"), names: ["image[]"], Page: lazy(() => import("@/app/base-images/[...image]/page"))},
  {pattern: new RegExp("^/base-images/?$"), names: [], Page: lazy(() => import("@/app/base-images/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/([^/]+)/logs/?$"), names: ["uid", "podUid"], Page: lazy(() => import("@/app/topmost-owners/[uid]/[podUid]/logs/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/logs/?$"), names: ["uid"], Page: lazy(() => import("@/app/topmost-owners/[uid]/logs/page"))},
  {pattern: new RegExp("^/namespaces/([^/]+)/logs/?$"), names: ["namespace"], Page: lazy(() => import("@/app/namespaces/[namespace]/logs/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/([^/]+)/network-topology/?$"), names: ["uid", "podUid"], Page: lazy(() => import("@/app/topmost-owners/[uid]/[podUid]/network-topology/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/images/([^/]+)/?$"), names: ["uid", "digest"], Page: lazy(() => import("@/app/topmost-owners/[uid]/images/[digest]/page"))},
  {pattern: new RegExp("^/helm-releases/([^/]+)/chart/?$"), names: ["uid"], Page: lazy(() => import("@/app/helm-releases/[uid]/chart/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/([^/]+)/?$"), names: ["uid", "podUid"], Page: lazy(() => import("@/app/topmost-owners/[uid]/[podUid]/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/network-topology/?$"), names: ["uid"], Page: lazy(() => import("@/app/topmost-owners/[uid]/network-topology/page"))},
  {pattern: new RegExp("^/container-images/(.+)/?$"), names: ["image[]"], Page: lazy(() => import("@/app/container-images/[...image]/page"))},
  {pattern: new RegExp("^/helm-releases/([^/]+)/?$"), names: ["uid"], Page: lazy(() => import("@/app/helm-releases/[uid]/page"))},
  {pattern: new RegExp("^/sandboxes/([^/]+)/?$"), names: ["sandbox"], Page: lazy(() => import("@/app/sandboxes/[sandbox]/page"))},
  {pattern: new RegExp("^/topmost-owners/([^/]+)/?$"), names: ["uid"], Page: lazy(() => import("@/app/topmost-owners/[uid]/page"))},
  {pattern: new RegExp("^/yaml/([^/]+)/?$"), names: ["uid"], Page: lazy(() => import("@/app/yaml/[uid]/page"))},
  {pattern: new RegExp("^/namespaces/([^/]+)/?$"), names: ["namespace"], Page: lazy(() => import("@/app/namespaces/[namespace]/page"))},
  {pattern: new RegExp("^/service-accounts/([^/]+)/([^/]+)/?$"), names: ["namespace", "name"], Page: lazy(() => import("@/app/service-accounts/[namespace]/[name]/page"))},
  {pattern: new RegExp("^/users/([^/]+)/?$"), names: ["name"], Page: lazy(() => import("@/app/users/[name]/page"))},
  {pattern: new RegExp("^/groups/([^/]+)/?$"), names: ["group"], Page: lazy(() => import("@/app/groups/[group]/page"))},
  {pattern: new RegExp("^/applications/?$"), names: [], Page: lazy(() => import("@/app/applications/page"))},
  {pattern: new RegExp("^/cluster/?$"), names: [], Page: lazy(() => import("@/app/cluster/page"))},
  {pattern: new RegExp("^/container-images/?$"), names: [], Page: lazy(() => import("@/app/container-images/page"))},
  {pattern: new RegExp("^/executive-summary/?$"), names: [], Page: lazy(() => import("@/app/executive-summary/page"))},
  {pattern: new RegExp("^/export/?$"), names: [], Page: lazy(() => import("@/app/export/page"))},
  {pattern: new RegExp("^/helm-releases/?$"), names: [], Page: lazy(() => import("@/app/helm-releases/page"))},
  {pattern: new RegExp("^/volumes/?$"), names: [], Page: lazy(() => import("@/app/volumes/page"))},
  {pattern: new RegExp("^/namespaces/?$"), names: [], Page: lazy(() => import("@/app/namespaces/page"))},
  {pattern: new RegExp("^/advisories/?$"), names: [], Page: lazy(() => import("@/app/advisories/page"))},
  {pattern: new RegExp("^/vulnerabilities/?$"), names: [], Page: lazy(() => import("@/app/vulnerabilities/page"))},
  {pattern: new RegExp("^/admission-policies/?$"), names: [], Page: lazy(() => import("@/app/admission-policies/page"))},
  {pattern: new RegExp("^/operators/?$"), names: [], Page: lazy(() => import("@/app/operators/page"))},
  {pattern: new RegExp("^/storage-classes/?$"), names: [], Page: lazy(() => import("@/app/storage-classes/page"))},
  {pattern: new RegExp("^/coding-agent/?$"), names: [], Page: lazy(() => import("@/app/coding-agent/page"))},
  {pattern: new RegExp("^/registry/?$"), names: [], Page: lazy(() => import("@/app/registry/page"))},
  {pattern: new RegExp("^/service-accounts/?$"), names: [], Page: lazy(() => import("@/app/service-accounts/page"))},
  {pattern: new RegExp("^/trust/?$"), names: [], Page: lazy(() => import("@/app/trust/page"))},
  {pattern: new RegExp("^/priority-classes/?$"), names: [], Page: lazy(() => import("@/app/priority-classes/page"))},
  {pattern: new RegExp("^/users/?$"), names: [], Page: lazy(() => import("@/app/users/page"))},
  {pattern: new RegExp("^/groups/?$"), names: [], Page: lazy(() => import("@/app/groups/page"))},
  {pattern: new RegExp("^/sandboxes/?$"), names: [], Page: lazy(() => import("@/app/sandboxes/page"))},
  {pattern: new RegExp("^/topmost-owners/?$"), names: [], Page: lazy(() => import("@/app/topmost-owners/page"))},
 ]

export default function Dashboard() {
 const pathname = usePathname()
 const connected = useClusterState(state=>state.isConnected)
 const connecting = useConnectionProgress(state=>state.target)
 const initiating = useConnectionProgress(state=>state.initiating)
 const connectionError = useConnectionProgress(state=>state.error)
 const fetching=useClusterState(state=>state.isFetchingReport)
 const data=useClusterState(state=>state.data)
 const [inventoryScope,setInventoryScope]=useState<string|null>(null)
 const [claims,setClaims] = useState<SessionClaims|null>(null)
 const [error,setError] = useState("")
 const [clusters,setClusters] = useState<ReturnType<typeof endpoints>>([])
 const [active,setActive] = useState("")
 const [configured,setConfigured] = useState<boolean|null>(null)
 const [pinnedEndpoints,setPinnedEndpoints] = useState<string[]>([])
 const [warnings,setWarnings] = useState<string[]>([])
 const [missingComponents,setMissingComponents] = useState<string[]>([])
 const [streamUpdates,setStreamUpdates] = useState(()=>typeof window==="undefined" || localStorage.getItem("driftmower.streamUpdates")!=="false")
 useEffect(()=>{localStorage.setItem("driftmower.streamUpdates",String(streamUpdates))},[streamUpdates])
 useEffect(() => {
  let cancelled=false
  restoreConnectionProgress()
  void (async () => {
   const config = await deploymentConfig()
   if (cancelled) return
   setConfigured(Boolean(config.mcpUrl))
   const discovered = config.mcpUrl ? [{name:contextTitle(config.mcpUrl),url:config.mcpUrl}] : config.clusters ?? []
   setPinnedEndpoints(discovered.map(endpoint=>endpoint.url))
   setClusters(discovered)
   const connectKey=new URLSearchParams(location.search).get("connect")
   if(connectKey){
    const target=config.contexts?.find(c=>c.key===connectKey)
    history.replaceState(null,"","/settings")
    if(!target)throw new Error("The selected connection is no longer available")
    if(!target.url||target.status!=="available"){
     sessionStorage.setItem("driftmower.pending-connect",target.key)
     return
    }
    await loginToEndpoint(target.url,target.key)
    return
   }
   if(config.discoveryEnabled&&location.pathname==="/settings"&&!sessionStorage.getItem("driftmower.selected"))return
   if (!config.mcpUrl && discovered.length === 0) return
   setActive(await selectedEndpoint())
   if (location.pathname === "/callback") await finishLogin()
   const signedIn=await user()
   if (!signedIn || signedIn.expired) return
   const profile=signedIn.profile
   if (cancelled) return
   setClaims({sub:profile.sub,name:profile.name,email:profile.email,groups:Array.isArray(profile.groups)?profile.groups as string[]:[]})
   useSandboxContext.setState({hydrated:true,available:false,admin:false,initialized:true})
   if (location.pathname === "/" || location.pathname === "/callback") navigate("/executive-summary",true)
  })().catch(e=>{connectionProgress(null);setError(e.message)})
  return()=>{cancelled=true}
 },[])
 useEffect(() => {
  if (!claims || initiating) return
  let cancelled=false
  let timer: ReturnType<typeof setTimeout>
 let unsubscribe: (()=>void)|undefined
 let subscribedUri: string|undefined
 let loading=false
 let scansLoading=false

  async function refresh() {
   if(loading||cancelled)return
   loading=true
   const connectionOperation=useConnectionProgress.getState().operation
   useClusterState.setState({isFetchingReport:true})
   clearTimeout(timer)
   try {
    const status=await callTool<InventoryStatus>("get_inventory_status", {})
    if(cancelled)return
    useClusterState.setState({clusterName:status.clusterContext,prometheusUrl:status.prometheusUrl??null,isConnected:true})
    if(useConnectionProgress.getState().operation===connectionOperation)connectionProgress(null)
    if(!needsInventory(pathname)){useClusterState.setState({isFetchingReport:false,error:null});setError("");loading=false;return}
    const snapshot=await loadCrawlerFindings(await loadInventory(status,inventoryNamespace(pathname),()=>cancelled))
    if (cancelled) return
    const selectedImages=selectedImageUsages(pathname,snapshot.imageUsages)
    if(!/^\/vulnerabilities(?:\/|$)/.test(pathname)&&selectedImages.length){
     const usages=selectedImages
     const digests=[...new Set(usages.map(u=>u.imageInfo.digest).filter(d=>/^sha256:[a-f0-9]{64}$/.test(d)))]
     for(let offset=0;offset<digests.length&&!cancelled;offset+=8){
      const metadata=await callTool<{images:Record<string,Partial<(typeof usages)[number]["imageInfo"]>>;warnings?:string[]}>("get_image_metadata",{digests:digests.slice(offset,offset+8)})
      for(const usage of usages)Object.assign(usage.imageInfo,metadata.images[usage.imageInfo.digest]??{})
      snapshot.warnings?.push(...(metadata.warnings??[]))
     }
    }
    if(pathname.startsWith("/helm-releases")){
     const helm=await callTool<{releases:(import("@/lib/cluster/reports").ReleaseInfo&{workloadUIDs?:string[]})[];warnings?:string[]}>("list_helm_releases",{})
     snapshot.warnings?.push(...(helm.warnings??[]))
     for(const release of helm.releases){
      const items=snapshot.imageUsages.filter(u=>u.releaseInfo?.groupKey===release.groupKey||release.workloadUIDs?.includes(u.workloadRootInfo?.uid??""))
      for(const usage of items)usage.releaseInfo=release
      snapshot.releaseGroups[release.groupKey]=items
      snapshot.drift.releaseScores[release.groupKey]={...snapshot.drift.releaseScores[release.groupKey],groupKey:release.groupKey,releaseInfo:release,normalizedScore:snapshot.drift.releaseScores[release.groupKey]?.normalizedScore??0,distinctRepoCount:snapshot.drift.releaseScores[release.groupKey]?.distinctRepoCount??0,staleRepoCount:snapshot.drift.releaseScores[release.groupKey]?.staleRepoCount??0,totalContainers:items.length,totalWorkloadCount:release.workloadUIDs?.length??0}
     }
    }
    if(cancelled)return
    setInventoryScope(inventoryNamespace(pathname)??"")
    useClusterState.setState({data:presentationData(snapshot),reportId:null,clusterName:snapshot.clusterContext,clusterResources:snapshot.resources,prometheusUrl:snapshot.prometheusUrl??null,isConnected:true,isFetchingReport:false,error:null,lastRefreshed:new Date(),vulnerabilityReportsError:null})
    if(!scansLoading&&selectedImages.length){
     scansLoading=true
     const scoped=selectedImages
     void loadImageScans(scoped,()=>cancelled).catch(e=>{if(!cancelled)useClusterState.setState({vulnerabilityReportsError:(e as Error).message})}).finally(()=>{scansLoading=false})
    }
    if(useConnectionProgress.getState().operation===connectionOperation)connectionProgress(null)
    setWarnings(snapshot.warnings??[]);setMissingComponents(snapshot.missingComponents??[]);setError("")
    // Resubscribing on every refresh could let the old unsubscribe land
    // after the new subscribe; only a changed URI is resubscribed.
    if (streamUpdates && snapshot.subscriptionUri && snapshot.subscriptionUri!==subscribedUri) {
      unsubscribe?.();unsubscribe=undefined;subscribedUri=undefined
      try { const stop=await subscribeDashboard(snapshot.subscriptionUri,()=>void refresh()); if(cancelled)stop();else {unsubscribe=stop;subscribedUri=snapshot.subscriptionUri} } catch { /* Automatic polling remains available. */ }
    }
   } catch(e) {if(!cancelled) {if(useConnectionProgress.getState().operation===connectionOperation)connectionProgress(null);setError((e as Error).message);useClusterState.setState({isFetchingReport:false,error:(e as Error).message})}}
   loading=false
   if (!cancelled && streamUpdates) timer=setTimeout(refresh,unsubscribe?300_000:30_000)
  }
  const manualRefresh=()=>void refresh()
  window.addEventListener("driftmower:refresh-inventory",manualRefresh)
  void refresh()
  // Mutating tools are offered only where the server enables them.
  void toolNames().then(tools=>{if(!cancelled)useFeatureFlags.setState({workloadRestart:tools.has("restart_workload")})}).catch(()=>{})
  return()=>{cancelled=true;clearTimeout(timer);unsubscribe?.();window.removeEventListener("driftmower:refresh-inventory",manualRefresh)}
 },[claims,streamUpdates,pathname,initiating])
 useEffect(()=>{
  let cancelled=false
  const timer=setInterval(()=>{void deploymentConfig(true).then(config=>{
   if(cancelled||config.mcpUrl)return
   setClusters(config.clusters??[])
   setPinnedEndpoints((config.clusters??[]).map(c=>c.url))
   const pending=sessionStorage.getItem("driftmower.pending-connect")
   const target=config.contexts?.find(c=>c.key===pending)
   if(target?.status==="available"&&target.url){
    sessionStorage.removeItem("driftmower.pending-connect")
    connectionProgress(null)
    void loginToEndpoint(target.url,target.key).catch(e=>setError((e as Error).message))
   }
  }).catch(()=>{})},5000)
  return()=>{cancelled=true;clearInterval(timer)}
 },[])
 const route=routes.find(r=>r.pattern.test(pathname))
 const match=route?.pattern.exec(pathname)
 const params:Record<string,string|string[]>={}
 route?.names.forEach((name,i)=>{const value=decodeURIComponent(match?.[i+1]??"");params[name.replace("[]","")]=name.endsWith("[]")?value.split("/"):value})
 return <SettingsContext.Provider value={{streamUpdates,setStreamUpdates}}><TooltipProvider><div className="flex h-screen flex-col bg-background text-foreground">
  <DashboardNotices messages={[connectionError, error, ...warnings]} missingComponents={missingComponents} />
  <ChromeProfilePrompt/>
  <div className="flex min-h-0 flex-1">
   <aside className="border-r"><NavBar claims={claims} navigationEnabled={connected} seesClusterWideViews={false} clusterEndpoints={clusters} activeEndpoint={active} pinnedEndpoints={pinnedEndpoints} fixedEndpoint={configured===true} onSelectEndpoint={(url,key)=>void loginToEndpoint(url,key).catch(e=>setError((e as Error).message))} /></aside>
   <main className="min-w-0 flex-1 overflow-auto"><Params.Provider value={params}><Suspense fallback={<p className="p-8">Loading…</p>}>
    {connecting&&pathname==="/executive-summary"?<div role="status" className="flex items-center gap-3 p-8"><LoaderCircle className="size-5 animate-spin" aria-hidden/><span>Connecting…</span></div>:!connected || pathname==="/settings"?<SettingsPage/>:needsInventory(pathname)&&fetching&&(!data||inventoryScope!==(inventoryNamespace(pathname)??""))?<p className="p-8">Loading inventory…</p>:route?<route.Page/>:<p className="p-8">Choose a page from the navigation.</p>}
   </Suspense></Params.Provider></main>
  </div>
 </div></TooltipProvider></SettingsContext.Provider>
}
