import { getSession } from "@/lib/auth/session"
import { fetchCapabilitiesFromMcp } from "@/lib/features/provisioning/mcp-capabilities"
import { mintMcpToken } from "@/lib/server/mcp-token"

// The provisioning page's facts, relayed from driftmower-mcp.
//
// driftmower-mcp owns the capability layer: it reads the cluster itself and
// asks the cluster authorizer, as the signed-in user, what they may see and
// do. This route turns the session into an MCP-audience token and forwards the
// same query, so the browser never holds that token and needs no CORS.

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(req: Request) {
  const baseUrl = process.env.DRIFTMOWER_MCP_URL

  if (!baseUrl) {
    return Response.json(
      {
        error: "mcp_not_configured",
        detail: "DRIFTMOWER_MCP_URL is unset, so this app has no driftmower-mcp to read cluster facts from.",
      },
      { status: 424, headers: NO_STORE }
    )
  }

  const token = await mintMcpToken(await getSession())

  if (!token.ok) {
    // A session that cannot mint the token is the page's "sign in again" case;
    // anything else is explained as it is.
    const status = token.reason === "reauthenticate" ? 401 : token.reason === "rejected" ? 400 : 424

    return Response.json(
      { error: token.reason === "disabled" ? "mcp_disabled" : `token_${token.reason}`, detail: token.detail },
      { status, headers: NO_STORE }
    )
  }

  const url = new URL(req.url)
  const namespaces = [
    ...new Set(
      (url.searchParams.get("ns") ?? "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
    ),
  ]
  const result = await fetchCapabilitiesFromMcp({
    baseUrl,
    accessToken: token.accessToken,
    namespaces,
    offering: url.searchParams.get("offering"),
  })

  if (!result.ok) console.error(`[provisioning] capabilities -> ${result.status} ${result.body.error}: ${result.body.detail}`)
  return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: NO_STORE })
}
