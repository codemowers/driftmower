import { inspect, inspecting } from "@/lib/features/inspector/store"
import { chooseChromeProfile } from "./chrome-profile-prompt"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
// The default validator compiles schemas with new Function, which the
// dashboard's Content-Security-Policy (no unsafe-eval) forbids.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker"
import { type Tool, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { InMemoryWebStorage,UserManager,WebStorageStateStore,type User } from "oidc-client-ts"
import { useKubeconfigState } from "@/lib/kubernetes/context-state"
import { connectionForEndpoint, type KubeconfigConnection } from "@/lib/kubernetes/contexts"
import { navigate } from "./navigation"
import { loginDestination, loginCallbackDestination } from "@/lib/connection/login-return"
import { connectionTitle } from "@/lib/kubernetes/labels"
import { fetchWithContext, mcpOperation, requestError } from "@/lib/http/request"
export { contextTitle } from "@/lib/kubernetes/labels"
import { connectionProgress, connectionStage, useConnectionProgress } from "@/lib/connection/progress"
export { connectionProgress, restoreConnectionProgress, useConnectionProgress } from "@/lib/connection/progress"

export type ClusterEndpoint = { name: string; url: string; contextKey?: string; authMethod?: string; portForward?:boolean }
export type ClientConfig = { authMode?: "oidc"; clientId: string; issuer: string; resource: string; scopes: string[] } | { authMode:"anonymous" }
export type ChromeProfile = {directory:string;name:string}
export type DashboardConfig = { configUpdates?:boolean;discoveryError?:string; chromeProfilesEnabled?:boolean;chromeProfiles?:ChromeProfile[];chromeProfilesError?:string;kubeContext?: string;  mcpUrl?: string; clusters?: ClusterEndpoint[]; discoveryEnabled?: boolean; contexts?: KubeconfigConnection[] }
let dashboardConfig: Promise<DashboardConfig> | null = null
let configLoading = false
export function deploymentConfig(refresh = false): Promise<DashboardConfig> {
  currentChromeProfile()
  if (refresh && !configLoading) dashboardConfig = null
  if (dashboardConfig) return dashboardConfig
  configLoading = true
  dashboardConfig = fetchWithContext("Load desktop configuration", "/dashboard-config.json").then(async response => {
    if (!response.ok) throw new Error(`Desktop configuration GET /dashboard-config.json returned HTTP ${response.status}`)
    const config: DashboardConfig = await response.json()
    const windowEndpoint=sessionStorage.getItem("driftmower.selected")
    const endpoint = (config.discoveryEnabled&&windowEndpoint) || config.mcpUrl || windowEndpoint || localStorage.getItem("driftmower.selected") || ""
    let selection: {key?: string; url?: string} = {}
    try { selection = JSON.parse(sessionStorage.getItem("driftmower.kubeconfig-context") || localStorage.getItem("driftmower.kubeconfig-context") || "{}") } catch { /* An old selection can be discarded. */ }
    useKubeconfigState.setState({ connections: config.contexts ?? [], defaultContext:config.kubeContext, endpoint, selectedKey: selection.url === endpoint ? selection.key : undefined })
    return config
  }).catch(error => { dashboardConfig = null; throw error }).finally(() => { configLoading = false })
  return dashboardConfig
}
type ConfigListener = { update: (config: DashboardConfig) => void; error?: (error: Error) => void }
const configListeners = new Set<ConfigListener>()
let configEvents: EventSource | null = null
let nativeConfigEvents = false
let configRefreshTimer: ReturnType<typeof setTimeout> | undefined
let configRefreshing = false, configChanged = false
async function refreshDesktopConfig() {
  if (configRefreshing) { configChanged = true; return }
  configRefreshing = true
  try {
    do {
      configChanged = false
      const config = await deploymentConfig(true)
      for (const listener of configListeners) listener.update(config)
    } while (configChanged && configListeners.size)
  } catch (error) { for (const listener of configListeners) listener.error?.(error instanceof Error ? error : new Error(String(error))) }
  finally { configRefreshing = false }
}

function closeConfigEvents() { configEvents?.close(); configEvents = null; clearTimeout(configRefreshTimer) }
function openConfigEvents() {
  if (!nativeConfigEvents || !configListeners.size || configEvents) return
  configEvents = new EventSource("/api/desktop/events")
  configEvents.onmessage = () => {
    clearTimeout(configRefreshTimer)
    configRefreshTimer = setTimeout(() => { void refreshDesktopConfig() }, 25)
  }
}

// One native event stream per browser window, shared by Settings and navigation.
// Messages invalidate the config snapshot; no interval polls the local server.
export function subscribeDesktopConfig(update: ConfigListener["update"], error?: ConfigListener["error"]) {
  const listener = { update, error }; configListeners.add(listener)
  if (configListeners.size === 1) {
    window.addEventListener("pagehide", closeConfigEvents)
    window.addEventListener("pageshow", openConfigEvents)
  }
  void deploymentConfig().then(config => {
    if (!configListeners.has(listener)) return
    update(config)
    nativeConfigEvents = config.configUpdates === true
    if (nativeConfigEvents) openConfigEvents()
    else closeConfigEvents()
  }).catch(reason => { if (configListeners.has(listener)) error?.(reason instanceof Error ? reason : new Error(String(reason))) })
  return () => {
    configListeners.delete(listener)
    if (!configListeners.size) {
      closeConfigEvents()
      window.removeEventListener("pagehide", closeConfigEvents)
      window.removeEventListener("pageshow", openConfigEvents)
    }
  }
}

let client: Client | null = null
let manager: UserManager | null = null
let anonymousEndpoint: string | null = null
let connection: Promise<Client> | null = null
const memory = new InMemoryWebStorage()
export function endpoints(): ClusterEndpoint[] {
  try { return JSON.parse(localStorage.getItem("driftmower.clusters") || "[]") } catch { return [] }
}
export async function selectedEndpoint(): Promise<string> {
  const config = await deploymentConfig()
  if (config.mcpUrl&&!config.discoveryEnabled) return config.mcpUrl
  // A window stays on its chosen connection while that cluster is temporarily
  // unreachable or awaiting login; never silently send it to another cluster.
  const windowEndpoint=sessionStorage.getItem("driftmower.selected")
  if(windowEndpoint)return windowEndpoint
  const saved = localStorage.getItem("driftmower.selected")
  const available = config.discoveryEnabled ? config.clusters ?? [] : [...config.clusters ?? [],...endpoints()]
  if (saved && (saved===config.mcpUrl || available.some(item => item.url === saved))) return saved
  if(config.mcpUrl)return config.mcpUrl
  const first = available[0]
  if (first) {
    localStorage.setItem("driftmower.selected", first.url)
    sessionStorage.setItem("driftmower.selected", first.url)
    selectKubeconfigContext(first.url, connectionForEndpoint(config.contexts ?? [], first.url)?.key)
    return first.url
  }
  throw new Error("Add an MCP endpoint to connect")
}
export function selectKubeconfigContext(url: string, key?: string) {
  localStorage.setItem("driftmower.kubeconfig-context", JSON.stringify({ url, key }))
  sessionStorage.setItem("driftmower.kubeconfig-context", JSON.stringify({ url, key }))
  useKubeconfigState.setState({ endpoint: url, selectedKey: key })
}

export async function loginToEndpoint(url: string, contextKey?: string) {
  if(useConnectionProgress.getState().target)return
  const known = connectionForEndpoint(useKubeconfigState.getState().connections, url, contextKey)
  connectionProgress(url || contextKey || "cluster", true, connectionTitle(known, url))
  const operation=useConnectionProgress.getState().operation
  connectionStage("reading desktop connection configuration", "/dashboard-config.json", operation)
  const destination=loginDestination(location.pathname+location.search+location.hash,location.origin)
  if(destination!==location.pathname+location.search+location.hash)navigate(destination)
  try {
    const config=await deploymentConfig()
    let selected=connectionForEndpoint(config.contexts??[],url,contextKey)
    if(config.chromeProfilesEnabled&&selected){
      connectionStage("checking the Chrome profile",undefined,operation)
      selected=await ensureChromeProfile(selected.key)
      if(!selected){connectionProgress(null);return}
    }
    if (config.chromeProfilesEnabled && selected?.chromeProfile && selected.chromeProfile.directory!==currentChromeProfile()) {
      connectionStage("opening the selected Chrome profile","/api/desktop/connect",operation)
      const response=await fetchWithContext("Open Chrome profile", "/api/desktop/connect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:selected.key,returnTo:destination})})
      if (!response.ok) throw new Error((await response.text()).trim() || "Could not open Chrome profile")
      connectionProgress(null)
      return selected.chromeProfile.name
    }
    if(selected&&selected.status!=="available"){
      sessionStorage.setItem("driftmower.pending-connect",selected.key)
      connectionStage("retrying Kubernetes discovery",selected.apiServer ?? "/api/desktop/retry",operation)
      const retry=await fetchWithContext("Retry desktop connection", "/api/desktop/retry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:selected.key})})
      if(!retry.ok)throw new Error((await retry.text()).trim() || "Could not retry the connection")
      connectionStage("waiting for Kubernetes to discover the MCP endpoint",selected.apiServer,operation)
      return
    }
    connectionStage("closing the previous MCP connection",undefined,operation)
    await client?.close()
    client = null; connection = null; manager = null; anonymousEndpoint = null
    localStorage.setItem("driftmower.selected", url)
    sessionStorage.setItem("driftmower.selected", url)
    selectKubeconfigContext(url, contextKey)
    await login(destination)
  } catch(error) {
    connectionProgress(null)
    useConnectionProgress.setState({error:error instanceof Error ? error.message : String(error)})
    throw error
  }
}

export function currentChromeProfile():string|null {
  const url=new URL(location.href)
  const profile=url.searchParams.get("chrome-profile")
  if(profile){
    sessionStorage.setItem("driftmower.chrome-profile",profile)
    url.searchParams.delete("chrome-profile")
    history.replaceState(null,"",url.pathname+url.search+url.hash)
  }
  return sessionStorage.getItem("driftmower.chrome-profile")
}

export async function ensureChromeProfile(key:string):Promise<KubeconfigConnection|undefined>{
  const config=await deploymentConfig()
  const selected=config.contexts?.find(context=>context.key===key)
  if(!selected||!config.chromeProfilesEnabled||selected.chromeProfile)return selected
  const profiles=config.chromeProfiles??[]
  if(!profiles.length)return selected
  const directory=profiles.length===1?profiles[0].directory:await chooseChromeProfile(selected.name,profiles)
  if(!directory)return undefined
  const updated=await saveChromeProfile(key,directory)
  return updated.contexts?.find(context=>context.key===key)
}

export async function saveChromeProfile(key:string,directory:string) {
  const response=await fetchWithContext("Save Chrome profile", "/api/desktop/chrome-profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,directory})})
  if(!response.ok)throw new Error((await response.text()).trim() || "Could not save Chrome profile")
  if(sessionStorage.getItem("driftmower.pending-connect")===key)sessionStorage.removeItem("driftmower.pending-connect")
  return deploymentConfig(true)
}
export async function configure(): Promise<UserManager | null> {
  const operation=useConnectionProgress.getState().operation
  if (manager) return manager
  const endpoint = await selectedEndpoint()
  if (anonymousEndpoint === endpoint) return null
  connectionStage("loading MCP authentication configuration",new URL("/api/client-config",endpoint).href,operation)
  const response = await fetchWithContext("Load MCP authentication configuration", new URL("/api/client-config", endpoint))
  if (!response.ok) throw requestError(new Error(`HTTP ${response.status}`), "Load MCP authentication configuration", new URL("/api/client-config", endpoint), "GET")
  const config: ClientConfig = await response.json()
  if (config.authMode === "anonymous") { anonymousEndpoint = endpoint; return null }
  // An authenticated Kubernetes tunnel changes the transport address, while
  // the MCP server retains its configured OAuth resource/audience.
  const deployment = await deploymentConfig()
  const forwarded = deployment.contexts?.some(c=>c.url===endpoint && c.portForward)
  if (config.resource !== endpoint && !forwarded) throw new Error("MCP resource audience does not match the selected endpoint")
  manager = new UserManager({
    authority: config.issuer, client_id: config.clientId,
    redirect_uri: `${location.origin}/callback`, response_type: "code",
    scope: config.scopes.join(" "), resource: config.resource,
    extraTokenParams: { resource: config.resource },
    automaticSilentRenew: true, loadUserInfo: false,
    // Only the one-time PKCE transaction survives the login redirect.
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
    userStore: new WebStorageStateStore({ store: memory }),
  })
  return manager
}
// Runs the context's kubelogin on this machine (desktop application only);
// kubelogin opens the default browser when it cannot refresh silently.
export async function kubernetesSignIn(context: string): Promise<void> {
  const response = await fetchWithContext("Kubernetes sign-in", "/api/kubernetes-sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context }) })
  if (!response.ok) throw new Error((await response.text()).trim() || `Kubernetes sign-in failed (${response.status})`)
}
export async function login(returnTo=location.pathname+location.search+location.hash) {
  const destination=loginDestination(returnTo,location.origin)
  const auth = await configure()
  if (auth) { connectionStage("waiting for OIDC sign-in",auth.settings.authority); try { await auth.signinRedirect({state:{returnTo:destination}}) } catch (error) { throw requestError(error, "OIDC sign-in", auth.settings.authority) } }
  else location.assign(destination)
}
export async function logout() {
  connectionProgress(null)
  await client?.close(); client = null; connection = null
  await manager?.removeUser()
  anonymousEndpoint = null
  location.assign("/settings")
}
export async function user(): Promise<User | {profile:{sub:string;name:string;email?:string;groups:string[]};expired:false} | null> {
  const auth = await configure()
  return auth ? auth.getUser() : {profile:{sub:"system:anonymous",name:"Anonymous",groups:[]},expired:false}
}
export async function finishLogin() {
  const auth = await configure()
  let state:unknown
  if (auth) {
    connectionStage("completing OIDC sign-in",auth.settings.authority)
    try { state=(await auth.signinRedirectCallback()).state }
    catch (error) { throw requestError(error, "OIDC callback/token exchange", auth.settings.authority) }
  }
  navigate(loginCallbackDestination(state,location.origin),true)
}
export async function connect(): Promise<Client> {
  if (connection) return connection
  const operation=useConnectionProgress.getState().operation
  connection = (async () => {
    const auth = await configure()
    const token = await auth?.getUser()
    if (auth && (!token || token.expired)) throw new Error("Sign in to connect to this cluster")
    const endpoint = await selectedEndpoint()
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        if (auth) {
          let current = await auth.getUser()
          if (current?.expired) { try { current = await auth.signinSilent() } catch (error) { throw requestError(error, "OIDC token renewal", auth.settings.authority) } }
          if (!current) throw new Error("Your session ended. Sign in again.")
          headers.set("Authorization", `Bearer ${current.access_token}`)
        }
        const response = await fetchWithContext(mcpOperation(init), input, { ...init, headers })
        // A server restart invalidates its MCP sessions. Refresh all mounted
        // queries/subscriptions together, once, rather than retrying mutations.
        if (response.status === 404 && headers.has("mcp-session-id") && /session not found/i.test(await response.clone().text())) {
          const key = `driftmower.session-refresh:${endpoint}`
          const last = Number(sessionStorage.getItem(key) || 0)
          if (Date.now() - last > 30_000) {
            sessionStorage.setItem(key, String(Date.now()))
            location.reload()
          }
        }
        return response
      },
    })
    const next = new Client({ name: "driftmower-dashboard", version: "1" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
    connectionStage("initializing the MCP session",endpoint,operation)
    try { await next.connect(transport) } catch (error) { throw requestError(error, "Connect to MCP", endpoint) }
    client = next
    return next
  })().catch(error => { connection = null; throw error })
  return connection
}
// Discover the live catalog through the selected connection; no response cache.
// The tool list is fixed for a server session, so one listing serves every
// caller until the connection is replaced.
let toolCache: { connection: Promise<Client>; tools: Promise<Tool[]> } | undefined
export async function listMcpTools(): Promise<Tool[]> {
  const session = await connect()
  if (toolCache?.connection !== connection) {
    const tools = (async () => {
      const out: Tool[] = []
      let cursor: string | undefined
      do {
        const page = await session.listTools(cursor ? { cursor } : {})
        out.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)
      return out
    })()
    const entry = { connection: connection!, tools }
    toolCache = entry
    tools.catch(() => { if (toolCache === entry) toolCache = undefined })
  }
  return toolCache.tools
}

// Optional features are registered only when enabled on the server.
export async function toolNames(): Promise<Set<string>> {
  return new Set((await listMcpTools()).map(tool => tool.name))
}
export async function callTool<T>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const done = inspect({ kind: "tool", name, args })
  try {
    const result = await callToolUninspected<T>(name, args, signal)
    if (inspecting()) done({ status: "ok", response: result, bytes: JSON.stringify(result).length })
    return result
  } catch (error) {
    done({ status: "error", error: (error as Error).message })
    throw error
  }
}
async function callToolUninspected<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const operation=useConnectionProgress.getState().operation
  const endpoint = await selectedEndpoint()
  let result
  try {
    const session = await connect()
    if(name==="get_inventory_status")connectionStage("waiting for MCP inventory status",endpoint,operation)
    result = await session.callTool({ name, arguments: args }, undefined, { signal })
  } catch (error) { throw requestError(error, `MCP tool ${name}`, endpoint, "POST") }
  if (result.isError) throw new Error(`${name}: ${(result.content as { text?: string }[]).map(part => part.text || "").join("\n")}`)
  if (result.structuredContent) return result.structuredContent as T
  throw new Error(`${name} returned no structured data`)
}

// Fetch a non-MCP browser resource from the selected MCP server using the same
// audience-bound bearer as MCP calls (for example provisioning capabilities).
export async function fetchMcp(path: string, init: RequestInit = {}): Promise<Response> {
  const done = inspect({ kind: "http", name: path, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined })
  try {
    const response = await fetchMcpUninspected(path, init)
    if (inspecting()) {
      const text = await response.clone().text()
      let body: unknown = text.length > 2_000_000 ? `${text.length} bytes, body not kept` : text
      if (text.length <= 2_000_000) try { body = JSON.parse(text) } catch { /* Not JSON; keep the text. */ }
      done({ status: String(response.status), bytes: text.length, response: body })
    }
    return response
  } catch (error) {
    done({ status: "error", error: (error as Error).message })
    throw error
  }
}
async function fetchMcpUninspected(path: string, init: RequestInit): Promise<Response> {
  const auth = await configure()
  if (!auth) {
    const headers = new Headers(init.headers)
    headers.delete("Authorization")
    return fetchWithContext("Load MCP data", new URL(path, await selectedEndpoint()), {...init,headers})
  }
  let current = await auth.getUser()
  if (current?.expired) { try { current = await auth.signinSilent() } catch (error) { throw requestError(error, "OIDC token renewal", auth.settings.authority) } }
  if (!current) throw new Error("Sign in to connect to this cluster")
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${current.access_token}`)
  return fetchWithContext("Load MCP data", new URL(path, await selectedEndpoint()), { ...init, headers })
}

// One notification handler per client dispatches to every subscriber of a
// URI; the server subscription lives while any subscriber does.
const listeners = new Map<string, Set<() => void>>()
let notifiedClient: Client | null = null
export async function subscribeDashboard(uri: string, changed: () => void): Promise<() => void> {
 const current = await connect()
 if (notifiedClient !== current) {
  notifiedClient = current
  listeners.clear()
  current.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { listeners.get(notification.params.uri)?.forEach(callback => callback()) })
 }
 let callbacks = listeners.get(uri)
 const first = !callbacks
 if (!callbacks) { callbacks = new Set(); listeners.set(uri, callbacks) }
 callbacks.add(changed)
 const set = callbacks
 const stop = () => {
  set.delete(changed)
  if (set.size === 0 && listeners.get(uri) === set) { listeners.delete(uri); void current.unsubscribeResource({uri}).catch(()=>{}) }
 }
 if (first) { try { await current.subscribeResource({uri}) } catch (e) { stop(); throw e } }
 return stop
}

// GET responses use the browser's HTTP cache, isolated by bearer and URL.
export async function fetchMcpJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchMcp(path, init)
  if (!response.ok) throw requestError(new Error((await response.text()).trim() || response.statusText), `Load MCP data: HTTP ${response.status}`, new URL(path, await selectedEndpoint()), init?.method ?? "GET")
  return response.json() as Promise<T>
}
