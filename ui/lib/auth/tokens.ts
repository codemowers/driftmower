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
// platform-manager validates JWTs against.
function platformManagerAudience(): string {
  return process.env.PLATFORM_MANAGER_AUDIENCE || "https://platform-manager-api"
}

function isPmAccessTokenExpired(session: SessionData): boolean {
  if (!session.pmExpiresAt) {
    return true
  }

  return nowSeconds() >= session.pmExpiresAt - EXPIRY_SKEW_SECONDS
}

// Second resource-scoped access token for the platform-manager API, minted
// from the same refresh token but with its own resource indicator. Kept
// separate from the driftmower-api token fields on purpose: the two tokens
// carry different audiences and expire independently.
//
// Unlike getValidAccessToken, a refresh failure here does not destroy the
// session — the driftmower-api token may still be perfectly valid, so the
// caller just answers 401 for the platform-manager routes.
export async function getPlatformManagerToken(session: IronSession<SessionData>): Promise<string | null> {
  if (session.pmAccessToken && !isPmAccessTokenExpired(session)) {
    return session.pmAccessToken
  }

  if (!session.refreshToken) {
    return null
  }

  try {
    const config = await getOidcConfig()
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken, {
      resource: platformManagerAudience(),
    })

    session.pmAccessToken = tokens.access_token
    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600
    session.pmExpiresAt = nowSeconds() + expiresIn

    // Defensive: if the IdP rotates the refresh token on this grant, losing
    // the new one would break the next driftmower-api refresh too.
    if (tokens.refresh_token) {
      session.refreshToken = tokens.refresh_token
    }

    await session.save()

    return session.pmAccessToken ?? null
  } catch {
    return null
  }
}
