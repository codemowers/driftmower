"use client"
import { ChromeProfilePrompt } from "./chrome-profile-prompt"
import { loadCrawlerFindings } from "./crawler"
import { useEffect, useRef, useState, lazy, Suspense } from "react"
import { LoaderCircle } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import NavBar from "@/app/components/core/nav-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxContext } from "@/lib/tenancy/sandbox-context"
import { presentationData, type DashboardSnapshot } from "./snapshot"
import type { ImageUsage, ReleaseInfo } from "@/lib/cluster/reports"
import { useFeatureFlags } from "@/app/components/feature-flags-init"
import { callTool, toolNames, subscribeDashboard, subscribeDesktopConfig, deploymentConfig, endpoints, finishLogin, loginToEndpoint, connectionProgress, restoreConnectionProgress, useConnectionProgress, selectedEndpoint, user, contextTitle } from "./connection"
import { Params, usePathname, useSearchParams, navigate } from "./navigation"
import { automaticLoginEndpoint, automaticLoginKey } from "@/lib/connection/automatic-login"
import { loginDestination } from "@/lib/connection/login-return"
import { selectedImageMetadataUsages, selectedImageUsages } from "@/lib/features/images/selection"
import { loadImageScans } from "./image-scans"
import { loadInventory, inventoryQuery, type InventoryStatus } from "./inventory"
import SettingsPage, { SettingsContext } from "./settings"
import DashboardNotices from "./dashboard-notices"
import RequestInspector from "./request-inspector"
import DownloadProgress from "@/app/components/download-progress"
import LoadingLine from "@/app/components/loading-line"
import type { SessionClaims } from "@/lib/auth/types"

const routes = [
 {pattern:new RegExp("^/packages/([^/]+)/?$"),names:["purl"],Page:lazy(()=>import("@/app/packages/[purl]/page"))},
 {pattern:new RegExp("^/packages/?$"),names:[],Page:lazy(()=>import("@/app/packages/page"))},
  {pattern: new RegExp("^/cluster/nodes/([^/]+)/?$"), names: ["name"], Page: lazy(() => import("@/app/cluster/nodes/[name]/page"))},
  {pattern: new RegExp("^/coding-agent/mcp-servers/driftmower/?$"), names: [], Page: lazy(() => import("@/app/coding-agent/mcp-servers/driftmower/page"))},
  {pattern: new RegExp("^/vulnerabilities/([^/]+)/?$"), names: ["id"], Page: lazy(() => import("@/app/vulnerabilities/[id]/page"))},
  {pattern: new RegExp("^/source-repositories/([^/]+)/?$"), names: ["source"], Page: lazy(() => import("@/app/source-repositories/[source]/page"))},
  {pattern: new RegExp("^/source-repositories/?$"), names: [], Page: lazy(() => import("@/app/source-repositories/page"))},
  {pattern: new RegExp("^/volumes/pvc/([^/]+)/([^/]+)/?$"), names: ["namespace", "name"], Page: lazy(() => import("@/app/volumes/pvc/[namespace]/[name]/page"))},
  {pattern: new RegExp("^/volumes/pv/([^/]+)/?$"), names: ["name"], Page: lazy(() => import("@/app/volumes/pv/[name]/page"))},
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
  {pattern: new RegExp("^/alerts/?$"), names: [], Page: lazy(() => import("@/app/alerts/page"))},
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
 const features = useFeatureFlags()
 const pathname = usePathname()
 const searchParams = useSearchParams()
 const query = inventoryQuery(pathname, searchParams)
 // Routes asking the same question share one inventory load.
 const scope = query ? JSON.stringify(query) : null
 const connected = useClusterState(state=>state.isConnected)
 const connecting = useConnectionProgress(state=>state.target)
 const initiating = useConnectionProgress(state=>state.initiating)
 const connectionError = useConnectionProgress(state=>state.error)
 const fetching=useClusterState(state=>state.isFetchingReport)
 const data=useClusterState(state=>state.data)
 const [inventoryScope,setInventoryScope]=useState<string|null>(null)
 const [inventoryVersion,setInventoryVersion]=useState(0)
 const inventory=useRef<{snapshot:DashboardSnapshot;metadata:Set<string>;scans:Set<string>;helm:boolean}|null>(null)
 const [claims,setClaims] = useState<SessionClaims|null>(null)
 const [error,setError] = useState("")
 const [configError,setConfigError] = useState("")
 const [clusters,setClusters] = useState<ReturnType<typeof endpoints>>([])
 const [active,setActive] = useState("")
 const [desktop,setDesktop] = useState(false)
 const [viewRevision,setViewRevision] = useState(0)
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
   setConfigError(config.discoveryError ?? "")
   setDesktop(config.configUpdates === true || config.chromeProfilesEnabled === true)
   setConfigured(Boolean(config.mcpUrl))
   const discovered = config.mcpUrl ? [{name:contextTitle(config.mcpUrl),url:config.mcpUrl}] : config.clusters ?? []
   setPinnedEndpoints(discovered.map(endpoint=>endpoint.url))
   setClusters(discovered)
   const connectKey=new URLSearchParams(location.search).get("connect")
   if(connectKey){
    const target=config.contexts?.find(c=>c.key===connectKey)
    navigate(loginDestination(new URLSearchParams(location.search).get("return-to"),location.origin),true)
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
   if (cancelled) return
   if (!signedIn || signedIn.expired) {
    const endpoint=automaticLoginEndpoint(config,location.pathname,sessionStorage)
    if(endpoint)await loginToEndpoint(endpoint)
    return
   }
   if(config.mcpUrl)sessionStorage.removeItem(automaticLoginKey(config.mcpUrl))
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
 let refreshPending=false

  async function refresh() {
   if(cancelled)return
   if(loading){refreshPending=true;return}
   loading=true
   const connectionOperation=useConnectionProgress.getState().operation
   useClusterState.setState({isFetchingReport:true})
   clearTimeout(timer)
   try {
    const status=await callTool<InventoryStatus>("get_inventory_status", {})
    if(cancelled)return
    useClusterState.setState({clusterName:status.clusterContext,prometheusUrl:status.prometheusUrl??null,isConnected:true})
    if(useConnectionProgress.getState().operation===connectionOperation)connectionProgress(null)
    setMissingComponents(status.missingComponents??[])
    if(scope===null){useClusterState.setState({isFetchingReport:false,error:null});setError("");loading=false;return}
    const snapshot=await loadCrawlerFindings(await loadInventory(status,JSON.parse(scope),()=>cancelled))
    if (cancelled) return
    setInventoryScope(scope)
    inventory.current={snapshot,metadata:new Set(),scans:new Set(),helm:false}
    useClusterState.setState({data:presentationData(snapshot),reportId:null,clusterName:snapshot.clusterContext,clusterResources:snapshot.resources,prometheusUrl:snapshot.prometheusUrl??null,isConnected:true,isFetchingReport:false,error:null,lastRefreshed:new Date(),vulnerabilityReportsError:null})
    setInventoryVersion(v=>v+1)
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
   if(!cancelled&&refreshPending){refreshPending=false;void refresh();return}
   if (!cancelled && streamUpdates) timer=setTimeout(refresh,unsubscribe?300_000:30_000)
  }
  const manualRefresh=()=>void refresh()
  window.addEventListener("driftmower:refresh-inventory",manualRefresh)
  void refresh()
  // Mutating tools are offered only where the server enables them.
  void toolNames().then(tools=>{if(!cancelled)useFeatureFlags.setState({workloadRestart:tools.has("restart_workload"),oidcUsers:tools.has("list_oidc_users"),imageScans:tools.has("get_image_scans"),advisories:tools.has("get_workload_findings")})}).catch(()=>{})
  return()=>{cancelled=true;clearTimeout(timer);unsubscribe?.();window.removeEventListener("driftmower:refresh-inventory",manualRefresh)}
 },[claims,streamUpdates,scope,initiating])
 // Route detail loads on top of the current inventory: image metadata, Helm
 // releases and periodically refreshed scan findings for the mounted view.
 useEffect(()=>{
  const current=inventory.current
  if(!current||scope===null)return
  let cancelled=false
  let timer:ReturnType<typeof setTimeout>|undefined
  const abort=new AbortController()
  const run=()=>void (async()=>{
   const {snapshot}=current
   const selected=selectedImageUsages(pathname,snapshot.imageUsages)
   const metadataUsages=selectedImageMetadataUsages(pathname,snapshot.imageUsages)
   const digests=[...new Set(metadataUsages.map(u=>u.imageInfo.digest).filter(d=>/^sha256:[a-f0-9]{64}$/.test(d)))]
   let changed=false
   const metadata=digests.filter(d=>!current.metadata.has(d))
   if(metadata.length&&!/^\/vulnerabilities(?:\/|$)/.test(pathname)){
    const result=await callTool<{images:Record<string,Partial<ImageUsage["imageInfo"]>>;warnings?:string[]}>("get_image_metadata",{digests:metadata},abort.signal)
    if(cancelled||inventory.current!==current)return
    metadata.forEach(d=>current.metadata.add(d))
    for(const usage of snapshot.imageUsages)Object.assign(usage.imageInfo,result.images[usage.imageInfo.digest]??{})
    snapshot.warnings?.push(...(result.warnings??[]))
    changed=true
   }
   if(pathname.startsWith("/helm-releases")&&!current.helm){
    current.helm=true
    const helm=await callTool<{releases:(ReleaseInfo&{workloadUIDs?:string[]})[];warnings?:string[]}>("list_helm_releases",{},abort.signal)
    snapshot.warnings?.push(...(helm.warnings??[]))
    for(const release of helm.releases){
     const items=snapshot.imageUsages.filter(u=>u.releaseInfo?.groupKey===release.groupKey||release.workloadUIDs?.includes(u.workloadRootInfo?.uid??""))
     for(const usage of items)usage.releaseInfo=release
     snapshot.releaseGroups[release.groupKey]=items
     const score=snapshot.drift.releaseScores[release.groupKey]
     snapshot.drift.releaseScores[release.groupKey]={...score,groupKey:release.groupKey,releaseInfo:release,normalizedScore:score?.normalizedScore??0,distinctRepoCount:score?.distinctRepoCount??0,staleRepoCount:score?.staleRepoCount??0,totalContainers:items.length,totalWorkloadCount:release.workloadUIDs?.length??0}
    }
    changed=true
   }
   if(cancelled||inventory.current!==current)return
   if(changed){useClusterState.setState({data:presentationData(snapshot)});setWarnings([...(snapshot.warnings??[])])}
   // Poll unfinished scans; completed immutable findings refresh with inventory.
   const statuses=useClusterState.getState().imageScanStatuses
   const scans=selected.filter(u=>!current.scans.has(u.imageInfo.digest)||statuses[u.imageInfo.digest]!=="complete")
   if(scans.length && (await toolNames()).has("get_image_scans")){
    await loadImageScans(scans,()=>cancelled||inventory.current!==current,abort.signal)
    if(!cancelled&&inventory.current===current)for(const usage of scans)current.scans.add(usage.imageInfo.digest)
   }
  })().catch(e=>{if(!cancelled)useClusterState.setState({vulnerabilityReportsError:(e as Error).message})})
    .finally(()=>{if(!cancelled)timer=setTimeout(run,30_000)})
  run()
  return()=>{cancelled=true;abort.abort();clearTimeout(timer)}
 },[pathname,scope,inventoryVersion])
 useEffect(()=>subscribeDesktopConfig(config=>{
   setConfigError(config.discoveryError ?? "")
   if(config.mcpUrl)return
   setClusters(config.clusters??[])
   setPinnedEndpoints((config.clusters??[]).map(c=>c.url))
   const pending=sessionStorage.getItem("driftmower.pending-connect")
   const target=config.contexts?.find(c=>c.key===pending)
   if(target?.status==="available"&&target.url){
    sessionStorage.removeItem("driftmower.pending-connect")
    connectionProgress(null)
    void loginToEndpoint(target.url,target.key).catch(e=>setError((e as Error).message))
   }
 },error=>setConfigError(error.message)),[])

 const unavailable = (/^\/(users|groups)(?:\/|$)/.test(pathname) && !features.oidcUsers) || (/^\/vulnerabilities(?:\/|$)/.test(pathname) && !features.imageScans) || (pathname === "/advisories" && !features.advisories)
 const route=routes.find(r=>r.pattern.test(pathname))
 const match=route?.pattern.exec(pathname)
 const params:Record<string,string|string[]>={}
 route?.names.forEach((name,i)=>{const value=decodeURIComponent(match?.[i+1]??"");params[name.replace("[]","")]=name.endsWith("[]")?value.split("/"):value})
 return <SettingsContext.Provider value={{streamUpdates,setStreamUpdates}}><TooltipProvider><div className="flex h-screen flex-col bg-background text-foreground">
  <RequestInspector />
  <DashboardNotices desktop={desktop} onRefresh={()=>{setViewRevision(value=>value+1);window.dispatchEvent(new Event("driftmower:refresh-inventory"))}} messages={[connectionError, error, configError, ...warnings]} missingComponents={missingComponents} />
  <ChromeProfilePrompt/>
  <div className="flex min-h-0 flex-1">
   <aside className="border-r"><NavBar claims={claims} navigationEnabled={connected} seesClusterWideViews={false} clusterEndpoints={clusters} activeEndpoint={active} pinnedEndpoints={pinnedEndpoints} fixedEndpoint={configured===true} onSelectEndpoint={(url,key)=>void loginToEndpoint(url,key).catch(e=>setError((e as Error).message))} /></aside>
   <main className="min-w-0 flex-1 overflow-auto"><Params.Provider value={params}><Suspense fallback={<div className="p-8"><LoadingLine /></div>}>
    {connecting&&pathname!=="/settings"?<div role="status" className="flex items-center gap-3 p-8"><LoaderCircle className="size-5 animate-spin" aria-hidden/><span>Connecting…</span><DownloadProgress /></div>:!connected || pathname==="/settings"?<SettingsPage/>:query&&fetching&&(!data||inventoryScope!==scope)?<div className="p-8"><LoadingLine loading="inventory" /></div>:unavailable?<p className="p-8">This feature is unavailable in this cluster.</p>:route?<route.Page key={viewRevision}/>:<p className="p-8">Choose a page from the navigation.</p>}
   </Suspense></Params.Provider></main>
  </div>
 </div></TooltipProvider></SettingsContext.Provider>
}
