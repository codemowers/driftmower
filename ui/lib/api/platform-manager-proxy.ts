import { forwardRequest } from "@/lib/api/backend-proxy"
import { getSession } from "@/lib/auth/session"
import { getPlatformManagerToken } from "@/lib/auth/tokens"

// platform-manager (the tenancy control plane) is an optional deployment:
// without PLATFORM_MANAGER_URL the BFF routes answer 404 and the tenants
// page renders its "not configured" empty state.
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

  return forwardRequest(req, `${baseUrl}${upstreamPath}`, accessToken, "pm-proxy")
}
