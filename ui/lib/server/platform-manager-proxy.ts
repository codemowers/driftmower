import "server-only"

import { forwardRequest } from "@/lib/server/backend-proxy"
import { getSession } from "@/lib/auth/session"
import { getPlatformManagerToken } from "@/lib/auth/tokens"

export function platformManagerUrl(): string | null {
  const url = process.env.PLATFORM_MANAGER_URL
  return url ? url.replace(/\/+$/, "") : null
}

export type SandboxScope =
  | { state: "ok"; admin: boolean; namespaces: string[] }
  | { state: "not-configured" | "unauthenticated" | "unreachable" }

// platform-manager's shape. A sandbox is exactly one namespace: the older model
// of a tenant namespace plus 0..n application namespaces is gone, and the
// endpoint moved from /api/tenants to /api/sandboxes with it.
export type SandboxRecord = {
  sandbox: string
  name: string
  namespace: string
  owners?: string[]
  creator?: string
  stackChannel?: string
}

type SandboxesResponse = {
  admin: boolean
  sandboxes: SandboxRecord[]
}

export const SANDBOXES_PATH = "/api/sandboxes"

// Server-to-server read: callers scope their own response, so they need the values not a body.
export async function fetchSandboxScope(): Promise<SandboxScope> {
  const baseUrl = platformManagerUrl()

  if (!baseUrl) {
    return { state: "not-configured" }
  }

  const session = await getSession()
  const accessToken = await getPlatformManagerToken(session)

  if (!accessToken) {
    return { state: "unauthenticated" }
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}${SANDBOXES_PATH}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    })
  } catch (e) {
    const cause = e instanceof Error && e.cause ? String(e.cause) : String(e)
    console.error(`[pm-scope] GET ${baseUrl}${SANDBOXES_PATH} -> unreachable: ${cause}`)
    return { state: "unreachable" }
  }

  if (response.status === 401 || response.status === 403) {
    return { state: "unauthenticated" }
  }

  if (!response.ok) {
    console.error(`[pm-scope] GET ${baseUrl}${SANDBOXES_PATH} -> ${response.status} ${response.statusText}`)
    return { state: "unreachable" }
  }

  const body = (await response.json()) as SandboxesResponse
  const namespaces = (body.sandboxes ?? []).map(s => s.namespace).filter(Boolean)

  return { state: "ok", admin: body.admin, namespaces: [...new Set(namespaces)] }
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
