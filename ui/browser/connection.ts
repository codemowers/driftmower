import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UserManager, WebStorageStateStore, InMemoryWebStorage, type User } from "oidc-client-ts"

export type ClusterEndpoint = { name: string; url: string }
export type ClientConfig = { clientId: string; issuer: string; resource: string; scopes: string[] }
type DashboardConfig = { mcpUrl?: string; clusters?: ClusterEndpoint[] }
let dashboardConfig: Promise<DashboardConfig> | null = null
export function deploymentConfig(): Promise<DashboardConfig> {
  return dashboardConfig ??= fetch("/dashboard-config.json").then(async response => {
    if (!response.ok) throw new Error("Dashboard configuration is unavailable")
    const config: DashboardConfig = await response.json()
    for (const endpoint of config.clusters ?? []) {
      if (!endpoints().some(item => item.url === endpoint.url)) saveEndpoint(endpoint)
    }
    return config
  }).catch(error => { dashboardConfig = null; throw error })
}
let client: Client | null = null
let manager: UserManager | null = null
let connection: Promise<Client> | null = null
const memory = new InMemoryWebStorage()
export function endpoints(): ClusterEndpoint[] {
  try { return JSON.parse(localStorage.getItem("driftmower.clusters") || "[]") } catch { return [] }
}
export function contextTitle(endpoint: string): string {
  return new URL(endpoint).hostname.replace(/^mcp\.driftmower\./i, "")
}
export function saveEndpoint(endpoint: ClusterEndpoint) {
  const url = new URL(endpoint.url)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for remote MCP endpoints")
  if (url.username || url.password || url.search || url.hash) throw new Error("MCP URL must not contain credentials, a query or fragment")
  const items = endpoints().filter(item => item.url !== url.href)
  items.push({ name: contextTitle(url.href), url: url.href })
  localStorage.setItem("driftmower.clusters", JSON.stringify(items))
}
export async function selectedEndpoint(): Promise<string> {
  const config = await deploymentConfig()
  if (config.mcpUrl) return config.mcpUrl
  const saved = localStorage.getItem("driftmower.selected")
  if (saved) return saved
  const first = endpoints()[0]
  if (first) {
    localStorage.setItem("driftmower.selected", first.url)
    return first.url
  }
  throw new Error("Add an MCP endpoint to connect")
}
export async function selectEndpoint(url: string) {
  await client?.close()
  client = null; connection = null; manager = null
  localStorage.setItem("driftmower.selected", url)
  window.location.assign("/")
}
export async function loginToEndpoint(url: string) {
  await client?.close()
  client = null; connection = null; manager = null
  localStorage.setItem("driftmower.selected", url)
  await login()
}
export async function configure(): Promise<UserManager> {
  if (manager) return manager
  const endpoint = await selectedEndpoint()
  const response = await fetch(new URL("/api/client-config", endpoint))
  if (!response.ok) throw new Error(`MCP browser authentication is unavailable (${response.status})`)
  const config: ClientConfig = await response.json()
  if (config.resource !== endpoint) throw new Error("MCP resource audience does not match the selected endpoint")
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
export async function login() { await (await configure()).signinRedirect() }
export async function logout() {
  await client?.close(); client = null; connection = null
  await manager?.removeUser()
  location.assign("/")
}
export async function user(): Promise<User | null> { return (await configure()).getUser() }
export async function finishLogin() {
  await (await configure()).signinRedirectCallback()
  history.replaceState(null, "", "/executive-summary")
}
export async function connect(): Promise<Client> {
  if (connection) return connection
  connection = (async () => {
    const auth = await configure()
    const token = await auth.getUser()
    if (!token || token.expired) throw new Error("Sign in to connect to this cluster")
    const transport = new StreamableHTTPClientTransport(new URL(await selectedEndpoint()), {
      fetch: async (input, init) => {
        let current = await auth.getUser()
        if (current?.expired) current = await auth.signinSilent()
        if (!current) throw new Error("Your session ended. Sign in again.")
        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${current.access_token}`)
        return fetch(input, { ...init, headers })
      },
    })
    const next = new Client({ name: "driftmower-dashboard", version: "1" })
    await next.connect(transport)
    client = next
    return next
  })().catch(error => { connection = null; throw error })
  return connection
}
export async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await (await connect()).callTool({ name, arguments: args })
  if (result.isError) throw new Error((result.content as { text?: string }[]).map(part => part.text || "").join("\n"))
  if (result.structuredContent) return result.structuredContent as T
  throw new Error(`${name} returned no structured data`)
}

export async function subscribeDashboard(uri: string, changed: () => void): Promise<() => void> {
 const client = await connect()
 client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { if(notification.params.uri === uri) changed() })
 await client.subscribeResource({uri})
 return () => { void client.unsubscribeResource({uri}).catch(()=>{}) }
}
