import "server-only"

import { forwardRequest } from "@/lib/server/backend-proxy"
import { getSession } from "@/lib/auth/session"
import { getPlatformManagerToken } from "@/lib/auth/tokens"

export function platformManagerUrl(): string | null {
  const url = process.env.PLATFORM_MANAGER_URL
  return url ? url.replace(/\/+$/, "") : null
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
