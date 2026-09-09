import "server-only"

import { forwardRequest } from "@/lib/server/backend-proxy"
import { getSession } from "@/lib/auth/session"
import { getPlatformManagerToken } from "@/lib/auth/tokens"

export function platformManagerUrl(): string | null {
  const url = process.env.PLATFORM_MANAGER_URL
  return url ? url.replace(/\/+$/, "") : null
}

export type TenantScope =
  | { state: "ok"; admin: boolean; namespaces: string[] }
  | { state: "not-configured" | "unauthenticated" | "unreachable" }

type TenantsResponse = {
  admin: boolean
  tenants: { tenantNamespace: string; appNamespaces: string[] }[]
}

const SCOPE_TTL_MS = 15_000
// Failures are cached too: an absent platform-manager costs one attempt per interval, not per request.
const SCOPE_FAILURE_TTL_MS = 30_000
const scopeCache = new Map<string, { scope: TenantScope; expiresAt: number }>()

function rememberScope(key: string, scope: TenantScope, now: number): TenantScope {
  const ttl = scope.state === "ok" ? SCOPE_TTL_MS : SCOPE_FAILURE_TTL_MS
  scopeCache.set(key, { scope, expiresAt: now + ttl })
  for (const [cached, entry] of scopeCache) {
    if (entry.expiresAt <= now) scopeCache.delete(cached)
  }
  return scope
}

// Server-to-server read: callers scope their own response, so they need the values not a body.
export async function fetchTenantScope(): Promise<TenantScope> {
  const baseUrl = platformManagerUrl()

  if (!baseUrl) {
    return { state: "not-configured" }
  }

  const session = await getSession()
  const key = session.refreshToken ?? session.accessToken

  if (!key) {
    return { state: "unauthenticated" }
  }

  const now = Date.now()
  const cached = scopeCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.scope
  }

  const accessToken = await getPlatformManagerToken(session)

  if (!accessToken) {
    return rememberScope(key, { state: "unauthenticated" }, now)
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/tenants`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    })
  } catch (e) {
    const cause = e instanceof Error && e.cause ? String(e.cause) : String(e)
    console.error(`[pm-scope] GET ${baseUrl}/api/tenants -> unreachable: ${cause}`)
    return rememberScope(key, { state: "unreachable" }, now)
  }

  if (response.status === 401 || response.status === 403) {
    return rememberScope(key, { state: "unauthenticated" }, now)
  }

  if (!response.ok) {
    console.error(`[pm-scope] GET ${baseUrl}/api/tenants -> ${response.status} ${response.statusText}`)
    return rememberScope(key, { state: "unreachable" }, now)
  }

  const body = (await response.json()) as TenantsResponse
  const namespaces = body.tenants.flatMap(t => [t.tenantNamespace, ...t.appNamespaces])

  return rememberScope(
    key,
    { state: "ok", admin: body.admin, namespaces: [...new Set(namespaces)] },
    now,
  )
}

export async function proxyPlatformManagerRequest(req: Request, upstreamPath: string): Promise<Response> {
  const baseUrl = platformManagerUrl()

  if (!baseUrl) {
    return Response.json({ error: "platform-manager is not configured" }, { status: 404 })
  }

  const session = await getSession()
  const accessToken = await getPlatformManagerToken(session)

  if (!accessToken) {
    return Response.json({ error: "not authenticated" }, { status: 401 })
  }

  const response = await forwardRequest(req, `${baseUrl}${upstreamPath}`, accessToken, "pm-proxy")

  if (response.status === 502 && response.headers.get("x-proxy-unreachable") === "1") {
    return Response.json({ error: "platform-manager unreachable" }, { status: 503 })
  }

  return response
}
