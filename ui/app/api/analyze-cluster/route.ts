import { Agent } from "undici"
import { backendUrl, type FetchInit } from "@/lib/server/backend-proxy"
import { getSession } from "@/lib/auth/session"
import { getValidAccessToken } from "@/lib/auth/tokens"
import { causeOf } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

const triggerAgent = new Agent({
  connect: { timeout: 5_000 },
  headersTimeout: 0,
  bodyTimeout: 0,
})

export async function POST(req: Request) {
  const session = await getSession()
  // A fresh token, so the analysis covers every namespace the user holds now.
  // A cached one predates any sandbox created since it was minted, and the
  // backend scopes the scan to the token's namespaces claim: the new sandbox
  // would be missing from the report, or the scan would find no containers.
  const accessToken = await getValidAccessToken(session, { fresh: true })
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
  void fetch(`${backendUrl()}/analyze-cluster`, init)
    .then(res => {
      if (!res.ok) console.error(`[analyze-cluster] trigger -> ${res.status} ${res.statusText}`)
    })
    .catch(e => {
      const cause = causeOf(e)
      console.error(`[analyze-cluster] trigger failed: ${(e as Error).message}${cause ? ` (cause: ${cause})` : ""}`)
    })

  return new Response(null, { status: 202 })
}
