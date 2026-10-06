import { mcpAudience } from "@/lib/auth/mcp-audience"
import { getSession } from "@/lib/auth/session"
import { mintMcpToken } from "@/lib/server/mcp-token"
import { claudeCodePasteCommand } from "@/lib/features/provisioning/mcp-quickstarts"

// Mints an MCP-audience access token for the signed-in user, so they can paste
// one into an MCP client and be connected in a minute.
//
// This is the quick start, not the durable path. The token lasts about an hour
// (passmower's resourceIndicators accessTokenTTL) and this route has no way to
// give a client a refresh token, so a client configured with a static header
// will start failing after that. The durable path is OAuth + PKCE against the
// `driftmower-mcp` OIDCClient — see driftmower-mcp/manifests/oidcclient.yaml.
//
// Stays behind the session cookie like every other /api route (proxy.ts).

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET() {
  const session = await getSession()
  const result = await mintMcpToken(session)

  if (!result.ok) {
    switch (result.reason) {
      case "disabled":
        return Response.json({ error: "mcp_disabled", detail: result.detail }, { status: 503, headers: NO_STORE })
      case "reauthenticate":
        // No refresh token at all, or one the IdP no longer honours for this
        // resource (the session predates MCP_ENABLED, or the token is spent).
        // Both are fixed by signing in again, and neither is a server failure.
        return result.code
          ? Response.json(
              {
                error: "session_predates_mcp",
                detail: result.detail,
                action: "reauthenticate",
                hint: "Your session was created before MCP was enabled, so it carries no grant for the MCP audience. Signing in again fixes it.",
              },
              { status: 409, headers: NO_STORE }
            )
          : Response.json({ error: "no_refresh_token", detail: result.detail }, { status: 401, headers: NO_STORE })
      case "rejected":
        // A 4xx on purpose: Cloudflare replaces the body of an origin 5xx with
        // its own HTML page, and this explanation is meant to be read.
        return Response.json(
          { error: "token_grant_rejected", detail: result.detail, code: result.code },
          { status: 400, headers: NO_STORE }
        )
      case "unreachable":
        return Response.json({ error: "token_grant_failed", detail: result.detail }, { status: 502, headers: NO_STORE })
    }
  }

  const mcpUrl = process.env.MCP_PUBLIC_URL || "https://mcp.driftmower.ee-lte-1.codemowers.io"

  return Response.json(
    {
      accessToken: result.accessToken,
      audience: mcpAudience(),
      expiresIn: result.expiresIn,
      // The caveat travels with the token, so nobody wires this into a client
      // expecting it to keep working.
      caveat: `This token expires in about ${Math.round(result.expiresIn / 60)} minutes. For a connection that keeps working, use the OAuth flow instead of a pasted token.`,
      // Built by the same function the provisioning panel renders, so a curl
      // user and the page cannot be told different things.
      command: claudeCodePasteCommand({
        mcpUrl: `${mcpUrl.replace(/\/+$/, "")}/mcp`,
        token: result.accessToken,
        clientId: null,
      }),
    },
    { headers: NO_STORE }
  )
}
