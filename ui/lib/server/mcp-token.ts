import "server-only"

import * as oidc from "openid-client"

import { mcpAudience } from "@/lib/auth/mcp-audience"
import { getOidcConfig } from "@/lib/auth/oidc"
import type { SessionData } from "@/lib/auth/session"

// An access token for driftmower-mcp, minted for the signed-in user from their
// refresh token with the MCP resource indicator. Used by the provisioning page
// (whose facts now come from driftmower-mcp) and by the token quick start.
//
// Tokens are reused until a minute before they expire, keyed by refresh token,
// so rendering the page does not cost an IdP round trip every time. A rotated
// refresh token starts a new entry; the old one ages out.

export type McpTokenResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | {
      ok: false
      // disabled: MCP_ENABLED is off, so login never requested the resource.
      // reauthenticate: no refresh token, or one the IdP no longer honours for
      //   this resource (invalid_grant / invalid_target) — signing in fixes it.
      // rejected: any other OAuth error. unreachable: transport failure.
      reason: "disabled" | "reauthenticate" | "rejected" | "unreachable"
      detail: string
      code?: string
    }

type Session = SessionData & { save(): Promise<void> }

const REUSE_MARGIN_MS = 60_000
const MAX_CACHED = 500
const cache = new Map<string, { accessToken: string; expiresAt: number }>()

export async function mintMcpToken(session: Session, now: () => number = Date.now): Promise<McpTokenResult> {
  if (process.env.MCP_ENABLED !== "true") {
    return {
      ok: false,
      reason: "disabled",
      detail:
        "MCP_ENABLED is not true, so login does not request the MCP resource and no MCP-audience " +
        "token can be minted. A resource absent from the original grant fails the refresh with invalid_target.",
    }
  }

  if (!session.refreshToken) {
    return { ok: false, reason: "reauthenticate", detail: "Sign in again to obtain an MCP token." }
  }

  const cached = cache.get(session.refreshToken)

  if (cached && cached.expiresAt - REUSE_MARGIN_MS > now()) {
    return { ok: true, accessToken: cached.accessToken, expiresIn: Math.floor((cached.expiresAt - now()) / 1000) }
  }

  try {
    const config = await getOidcConfig()
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken, { resource: mcpAudience() })

    if (!tokens.access_token) {
      return { ok: false, reason: "rejected", detail: "The token grant returned no access token." }
    }

    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600
    const key = session.refreshToken

    // If the IdP rotates the refresh token on this grant, losing the new one
    // would break the next driftmower-api refresh too.
    if (tokens.refresh_token && tokens.refresh_token !== session.refreshToken) {
      session.refreshToken = tokens.refresh_token
      await session.save()
    }

    remember(tokens.refresh_token ?? key, tokens.access_token, now() + expiresIn * 1000)

    return { ok: true, accessToken: tokens.access_token, expiresIn }
  } catch (error) {
    const oauth = oauthErrorOf(error)
    const detail = oauth
      ? `${oauth.code}${oauth.description ? `: ${oauth.description}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error)

    console.error("[mcp] token grant failed:", detail)

    // invalid_target: the session predates MCP_ENABLED, so the original grant
    // carries no MCP resource. invalid_grant: the refresh token is spent.
    if (oauth && (oauth.code === "invalid_target" || oauth.code === "invalid_grant")) {
      return { ok: false, reason: "reauthenticate", detail, code: oauth.code }
    }

    return oauth
      ? { ok: false, reason: "rejected", detail, code: oauth.code }
      : { ok: false, reason: "unreachable", detail }
  }
}

function remember(refreshToken: string, accessToken: string, expiresAt: number): void {
  cache.delete(refreshToken)
  cache.set(refreshToken, { accessToken, expiresAt })

  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value

    if (oldest === undefined) break

    cache.delete(oldest)
  }
}

// oauth4webapi throws ResponseBodyError for an OAuth-shaped rejection, carrying
// the code on `.error` and the text on `.error_description`. `.cause` is the
// parsed JSON body — stringifying that yields "[object Object]".
function oauthErrorOf(error: unknown): { code: string; description?: string } | null {
  if (typeof error !== "object" || error === null) return null

  const candidate = error as { error?: unknown; error_description?: unknown }

  if (typeof candidate.error !== "string") return null

  return {
    code: candidate.error,
    description: typeof candidate.error_description === "string" ? candidate.error_description : undefined,
  }
}
