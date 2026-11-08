"use client"
import { useEffect, useState, lazy, Suspense } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import NavBar from "@/app/components/core/nav-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxContext } from "@/lib/tenancy/sandbox-context"
import { presentationData, type DashboardSnapshot } from "./snapshot"
import { callTool, subscribeDashboard, deploymentConfig, endpoints, finishLogin, loginToEndpoint, selectEndpoint, selectedEndpoint, user } from "./connection"
import { Params, usePathname, navigate } from "./navigation"
import type { SessionClaims } from "@/lib/auth/session"

const routes = [
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
  {pattern: new RegExp("^/applications/?$"), names: [], Page: lazy(() => import("@/app/applications/page"))},
  {pattern: new RegExp("^/cluster/?$"), names: [], Page: lazy(() => import("@/app/cluster/page"))},
  {pattern: new RegExp("^/container-images/?$"), names: [], Page: lazy(() => import("@/app/container-images/page"))},
  {pattern: new RegExp("^/executive-summary/?$"), names: [], Page: lazy(() => import("@/app/executive-summary/page"))},
  {pattern: new RegExp("^/export/?$"), names: [], Page: lazy(() => import("@/app/export/page"))},
  {pattern: new RegExp("^/helm-releases/?$"), names: [], Page: lazy(() => import("@/app/helm-releases/page"))},
  {pattern: new RegExp("^/provisioning/?$"), names: [], Page: lazy(() => import("@/app/provisioning/page"))},
  {pattern: new RegExp("^/sandboxes/?$"), names: [], Page: lazy(() => import("@/app/sandboxes/page"))},
  {pattern: new RegExp("^/topmost-owners/?$"), names: [], Page: lazy(() => import("@/app/topmost-owners/page"))},
 ]

export default function Dashboard() {
 const pathname = usePathname()
 const [claims,setClaims] = useState<SessionClaims|null>(null)
 const [error,setError] = useState("")
 const [clusters,setClusters] = useState(endpoints)
 const [active,setActive] = useState("")
 const [configured,setConfigured] = useState<boolean|null>(null)
 const [pinnedEndpoints,setPinnedEndpoints] = useState<string[]>([])
 const [warnings,setWarnings] = useState<string[]>([])
 const [streamUpdates,setStreamUpdates] = useState(()=>typeof window==="undefined" || localStorage.getItem("driftmower.streamUpdates")!=="false")
 useEffect(()=>{localStorage.setItem("driftmower.streamUpdates",String(streamUpdates))},[streamUpdates])
 useEffect(() => {
  let cancelled=false
  void (async () => {
   const config = await deploymentConfig()
   if (cancelled) return
   setConfigured(Boolean(config.mcpUrl))
   const discovered = config.mcpUrl ? [{name:new URL(config.mcpUrl).hostname,url:config.mcpUrl}] : config.clusters ?? []
   setPinnedEndpoints(discovered.map(endpoint=>endpoint.url))
   setClusters([...discovered,...endpoints().filter(item=>!discovered.some(endpoint=>endpoint.url===item.url))].map(endpoint=>({...endpoint,name:new URL(endpoint.url).hostname})))
   setActive(await selectedEndpoint())
   if (location.pathname === "/callback") await finishLogin()
   const signedIn=await user()
   if (!signedIn || signedIn.expired) return
   const profile=signedIn.profile
   if (cancelled) return
   setClaims({sub:profile.sub,name:profile.name,email:profile.email,groups:Array.isArray(profile.groups)?profile.groups as string[]:[]})
   useSandboxContext.setState({hydrated:true,available:false,admin:false,initialized:true})
   if (location.pathname === "/" || location.pathname === "/callback") navigate("/executive-summary",true)
  })().catch(e=>setError(e.message))
  return()=>{cancelled=true}
 },[])
 useEffect(() => {
  if (!claims) return
  let cancelled=false
  let timer: ReturnType<typeof setTimeout>
 let unsubscribe: (()=>void)|undefined
 let loading=false
  async function refresh() {
   if(loading||cancelled)return
   loading=true
   useClusterState.setState({isFetchingReport:true})
   clearTimeout(timer)
   try {
    const snapshot=await callTool<DashboardSnapshot>("get_dashboard_snapshot")
    if (cancelled) return
    useClusterState.setState({data:presentationData(snapshot),reportId:null,clusterName:snapshot.clusterContext,clusterResources:snapshot.resources,isConnected:true,isFetchingReport:false,error:null,lastRefreshed:new Date(),vulnerabilityReportsError:"Image scans are not available yet"})
    setWarnings(snapshot.warnings??[]);setError("")
    if (streamUpdates && snapshot.subscriptionUri) {
      unsubscribe?.();unsubscribe=undefined
      try { const stop=await subscribeDashboard(snapshot.subscriptionUri,()=>void refresh()); if(cancelled)stop();else unsubscribe=stop } catch { /* Automatic polling remains available. */ }
    }
   } catch(e) {if(!cancelled) {setError((e as Error).message);useClusterState.setState({isConnected:false,isFetchingReport:false,error:(e as Error).message})}}
   loading=false
   if (!cancelled && streamUpdates) timer=setTimeout(refresh,unsubscribe?300_000:30_000)
  }
  void refresh()
  return()=>{cancelled=true;clearTimeout(timer);unsubscribe?.()}
 },[claims,streamUpdates])
 const route=routes.find(r=>r.pattern.test(pathname))
 const match=route?.pattern.exec(pathname)
 const params:Record<string,string|string[]>={}
 route?.names.forEach((name,i)=>{const value=decodeURIComponent(match?.[i+1]??"");params[name.replace("[]","")]=name.endsWith("[]")?value.split("/"):value})
 return <TooltipProvider><div className="flex h-screen flex-col bg-background text-foreground">
  {error&&<p role="alert" className="border-b bg-red-50 p-3 text-sm text-red-900">{error}</p>}
  {warnings.length>0&&<details className="border-b p-2 text-sm"><summary>Inventory coverage: {warnings.length} notices</summary>{warnings.map(w=><p key={w}>{w}</p>)}</details>}
  {claims?<div className="flex min-h-0 flex-1"><aside className="border-r"><NavBar claims={claims} seesClusterWideViews={false} clusterEndpoints={clusters} activeEndpoint={active} pinnedEndpoints={pinnedEndpoints} fixedEndpoint={configured===true} onSelectEndpoint={url=>void selectEndpoint(url)} streamUpdates={streamUpdates} onStreamUpdatesChange={setStreamUpdates}/></aside><main className="min-w-0 flex-1 overflow-auto"><Params.Provider value={params}><Suspense fallback={<p className="p-8">Loading…</p>}>{route?<route.Page/>:<p className="p-8">Choose a page from the navigation.</p>}</Suspense></Params.Provider></main></div>:<main className="mx-auto w-full max-w-3xl overflow-auto p-8 sm:p-12">{configured === null ? <p>Loading contexts…</p> : <><h1 className="text-xl font-semibold">Choose a cluster context</h1><p className="mt-2 text-sm text-muted-foreground">Sign in to the MCP endpoint you want to inspect.</p><div className="mt-6 grid gap-3">{clusters.map(endpoint=><section key={endpoint.url} className="flex items-center justify-between gap-4 rounded-lg border bg-background p-4"><div className="min-w-0"><p className="truncate font-mono font-medium">{endpoint.name}</p><p className="truncate text-xs text-muted-foreground">{endpoint.url}</p>{pinnedEndpoints.includes(endpoint.url)&&<p className="mt-1 text-xs text-muted-foreground">Pinned · discovered from kubeconfig</p>}</div><button type="button" className="shrink-0 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" onClick={()=>void loginToEndpoint(endpoint.url).catch(err=>setError((err as Error).message))}>Sign in</button></section>)}</div>{clusters.length===0&&<p className="mt-6 rounded-md border p-4 text-sm text-muted-foreground">No MCP contexts were discovered. Add MCP endpoints to the dashboard deployment configuration.</p>}</>}</main>}
 </div></TooltipProvider>
}
