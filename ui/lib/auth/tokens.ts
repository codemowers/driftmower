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
