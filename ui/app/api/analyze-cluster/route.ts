import { Agent } from "undici"
import { backendUrl, type FetchInit } from "@/lib/server/backend-proxy"
import { getSession } from "@/lib/auth/session"
import { getValidAccessToken } from "@/lib/auth/tokens"

export const dynamic = "force-dynamic"

const triggerAgent = new Agent({
  connect: { timeout: 5_000 },
  headersTimeout: 0,
  bodyTimeout: 0,
})

export async function POST(req: Request) {
  const session = await getSession()
  const accessToken = await getValidAccessToken(session)
  if (!accessToken) {
    return Response.json({ error: "not authenticated" }, { status: 401 })
  }

  const body = await req.arrayBuffer()

  const init: FetchInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${accessToken}` },
    body,
    cache: "no-store",
    dispatcher: triggerAgent,
  }
  void fetch(`${backendUrl()}/analyze-cluster`, init).catch(e => {
    console.error("[analyze-cluster] trigger failed:", String(e))
  })

  return new Response(null, { status: 202 })
}
