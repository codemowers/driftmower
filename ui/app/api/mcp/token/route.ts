import * as oidc from "openid-client"

import { mcpAudience } from "@/lib/auth/bearer"
import { getOidcConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"
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
        // Built by the same function the provisioning panel renders, so a
        // curl user and the page cannot be told different things.
        command: claudeCodePasteCommand({
          mcpUrl: `${mcpUrl.replace(/\/+$/, "")}/mcp`,
          token: tokens.access_token,
          clientId: null,
        }),
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // A cause carries the IdP's own error code; the message alone often does not.
    const cause = error instanceof Error && error.cause ? String((error.cause as Error).message ?? error.cause) : ""
    const text = `${detail} ${cause}`.trim()

    // Without this a failure here is a 502 with nothing in the logs, which is
    // the worst combination to debug from — the detail only ever reached the
    // browser.
    console.error("[mcp] token grant failed:", text)

    // Two different situations, and only one of them is the server's fault.
    //
    // invalid_target: the MCP resource was not in the original grant, because
    // the session was created before MCP_ENABLED was turned on. invalid_grant:
    // the refresh token is spent or revoked. Both are fixed by signing in
    // again, neither is a bad gateway, and answering 502 tells the user to go
    // find an administrator when they could have fixed it in two clicks.
    const needsReauthentication = /invalid_target|invalid_grant/.test(text)

    if (needsReauthentication) {
      return Response.json(
        {
          error: "session_predates_mcp",
          detail: text,
          action: "reauthenticate",
          hint: "Your session was created before MCP was enabled, so it carries no grant for the MCP audience. Signing in again fixes it.",
        },
        { status: 409, headers: NO_STORE }
      )
    }

    return Response.json({ error: "token_grant_failed", detail: text }, { status: 502, headers: NO_STORE })
  }
}
