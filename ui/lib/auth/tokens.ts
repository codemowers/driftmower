import * as oidc from "openid-client"
import type { IronSession } from "iron-session"

import { getOidcConfig, getOidcRuntimeConfig } from "./oidc"
import type { SessionData } from "./session"

const EXPIRY_SKEW_SECONDS = 60

type TokenResponse = oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function isAccessTokenExpired(session: SessionData): boolean {
  if (!session.expiresAt) {
    return true
  }

  return nowSeconds() >= session.expiresAt - EXPIRY_SKEW_SECONDS
}

// The id_token is intentionally not stored: dropping it keeps the sealed
// cookie under the browser's per-cookie size limit.
export function applyTokens(session: IronSession<SessionData>, tokens: TokenResponse): void {
  session.accessToken = tokens.access_token

  if (tokens.refresh_token) {
    session.refreshToken = tokens.refresh_token
  }

  const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600
  session.expiresAt = nowSeconds() + expiresIn

  const claims = tokens.claims()

  if (claims) {
    const record = claims as Record<string, unknown>
    const rawGroups = record.groups
    const groups = Array.isArray(rawGroups)
      ? (rawGroups.filter((g) => typeof g === "string") as string[])
      : []

    session.claims = {
      sub: String(claims.sub),
      name: typeof record.name === "string" ? record.name : undefined,
      email: typeof record.email === "string" ? record.email : undefined,
      groups,
    }
  }
}

export async function getValidAccessToken(session: IronSession<SessionData>): Promise<string | null> {
  if (!session.accessToken) {
    return null
  }

  if (!isAccessTokenExpired(session)) {
    return session.accessToken
  }

  if (!session.refreshToken) {
    await session.destroy()
    return null
  }

  try {
    const config = await getOidcConfig()
    const { resource } = getOidcRuntimeConfig()
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken, { resource })

    applyTokens(session, tokens)
    await session.save()

    return session.accessToken ?? null
  } catch {
    await session.destroy()
    return null
  }
}

// RFC 8707 resource indicator for platform-manager; must equal the audience
// platform-manager validates JWTs against. Exported so the login route can
// include it as a second resource at authorization time — the IdP only mints
// tokens for resources present in the original grant.
export function platformManagerAudience(): string {
  return process.env.PLATFORM_MANAGER_AUDIENCE || "https://platform-manager-api"
}

// In-memory cache for platform-manager access tokens, keyed by the session's
// refresh token. Deliberately NOT stored in the iron-session cookie: a second
// RS256 JWT (now carrying the namespaces claim) can push the cookie past the
// 4KB limit, making session.save() fail after a perfectly successful grant —
// and this BFF is a single replica, so process memory is a safe cache. Entries
// die with the process or the TTL, whichever comes first.
const pmTokenCache = new Map<string, { token: string; expiresAt: number }>()

// Second resource-scoped access token for the platform-manager API, minted
// from the same refresh token but with its own resource indicator (RFC 8707).
//
// Unlike getValidAccessToken, a refresh failure here does not destroy the
// session — the driftmower-api token may still be perfectly valid, so the
// caller just answers 401 for the platform-manager routes.
export async function getPlatformManagerToken(session: IronSession<SessionData>): Promise<string | null> {
  if (!session.refreshToken) {
    return null
  }

  const cached = pmTokenCache.get(session.refreshToken)
  if (cached && nowSeconds() < cached.expiresAt - EXPIRY_SKEW_SECONDS) {
    return cached.token
  }

  try {
    const config = await getOidcConfig()
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken, {
      resource: platformManagerAudience(),
    })

    if (!tokens.access_token) {
      return null
    }

    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600
    pmTokenCache.set(session.refreshToken, {
      token: tokens.access_token,
      expiresAt: nowSeconds() + expiresIn,
    })

    // Defensive: if the IdP rotates the refresh token on this grant, losing
    // the new one would break the next driftmower-api refresh too. Re-key the
    // cache so the new cookie value still finds the token.
    if (tokens.refresh_token && tokens.refresh_token !== session.refreshToken) {
      pmTokenCache.set(tokens.refresh_token, pmTokenCache.get(session.refreshToken)!)
      pmTokenCache.delete(session.refreshToken)
      session.refreshToken = tokens.refresh_token
      await session.save()
    }

    return tokens.access_token
  } catch (error) {
    console.error("platform-manager token grant failed:", error)
    return null
  }
}
