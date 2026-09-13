import * as oidc from "openid-client"

import { mcpAudience } from "@/lib/auth/bearer"
import { getOidcConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"

// Mints an MCP-audience access token for the signed-in user, so they can paste
// one into an MCP client and be connected in a minute.
//
// This is the quick start, not the durable path. The token lasts about an hour
// (passmower's resourceIndicators accessTokenTTL) and this route has no way to
// give a client a refresh token, so a client configured with a static header
// will start failing after that. The durable path is OAuth + PKCE against the
// `driftmower-mcp` OIDCClient — see driftmower-mcp/manifests/oidcclient.yaml.
//
// Stays behind the session cookie: proxy.ts exempts only
// /api/provisioning/capabilities, and only when a bearer is present, so this
// route keeps the cookie gate.

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET() {
  if (process.env.MCP_ENABLED !== "true") {
    return Response.json(
      {
        error: "mcp_disabled",
        detail:
          "MCP_ENABLED is not true, so login does not request the MCP resource and no MCP-audience " +
          "token can be minted. A resource absent from the original grant fails the refresh with invalid_target.",
      },
      { status: 503, headers: NO_STORE }
    )
  }

  const session = await getSession()

  if (!session.refreshToken) {
    return Response.json(
      { error: "no_refresh_token", detail: "Sign in again to obtain an MCP token." },
      { status: 401, headers: NO_STORE }
    )
  }

  try {
    const config = await getOidcConfig()
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken, {
      resource: mcpAudience(),
    })

    if (!tokens.access_token) {
      return Response.json(
        { error: "no_access_token", detail: "The token grant returned no access token." },
        { status: 502, headers: NO_STORE }
      )
    }

    // Defensive, mirroring getPlatformManagerToken: if the IdP rotates the
    // refresh token on this grant, losing the new one would break the next
    // driftmower-api refresh too.
    if (tokens.refresh_token && tokens.refresh_token !== session.refreshToken) {
      session.refreshToken = tokens.refresh_token
      await session.save()
    }

    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600
    const mcpUrl = process.env.MCP_PUBLIC_URL || "https://driftmower-mcp.ee-lte-1.codemowers.io"

    return Response.json(
      {
        accessToken: tokens.access_token,
        audience: mcpAudience(),
        expiresIn,
        // The caveat travels with the token, so nobody wires this into a client
        // expecting it to keep working.
        caveat: `This token expires in about ${Math.round(expiresIn / 60)} minutes. For a connection that keeps working, use the OAuth flow instead of a pasted token.`,
        command: `claude mcp add --transport http driftmower ${mcpUrl.replace(/\/+$/, "")}/mcp --header "Authorization: Bearer ${tokens.access_token}"`,
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    // invalid_target here means the MCP resource was not in the original grant:
    // the user signed in before MCP_ENABLED was turned on and must sign in again.
    return Response.json(
      {
        error: "token_grant_failed",
        detail,
        hint: detail.includes("invalid_target")
          ? "Sign out and back in: the MCP resource must be present in the original authorization grant."
          : undefined,
      },
      { status: 502, headers: NO_STORE }
    )
  }
}
