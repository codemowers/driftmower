import "server-only"

import * as oidc from "openid-client"
import type { IronSession } from "iron-session"

import { createDeadTokenRegistry, isDeadTokenError } from "./dead-refresh-tokens"
import { getOidcConfig, getOidcRuntimeConfig } from "./oidc"
import type { SessionData } from "./session"
import { causeOf } from "@/lib/server/error-response"

const EXPIRY_SKEW_SECONDS = 60

const deadRefreshTokens = createDeadTokenRegistry()

// A Server Component may not write cookies, and getPlatformManagerToken is
// reached from the root layout. There the session cannot be ended; the dead
// token is remembered instead, and the next route handler ends it.
async function destroySessionIfWritable(session: IronSession<SessionData>): Promise<void> {
  try {
    await session.destroy()
  } catch {
    // Not writable from here.
  }
}

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

export function describeOAuthError(error: unknown): { detail: string; cause?: string; rejected: boolean } {
  const oauth = error as { error?: unknown; error_description?: unknown }
  const cause = causeOf(error)
  if (typeof oauth.error === "string") {
    const description = typeof oauth.error_description === "string" ? `: ${oauth.error_description}` : ""
    return { detail: `${oauth.error}${description}`, cause, rejected: true }
  }
  return { detail: error instanceof Error ? error.message : String(error), cause, rejected: false }
}

function logOAuthFailure(what: string, error: unknown): boolean {
  const { detail, cause, rejected } = describeOAuthError(error)
  console.error(`[auth] ${what} failed: ${detail}${cause ? ` (cause: ${cause})` : ""}`)
  return rejected
}

// `fresh` skips the cached token and always runs a refresh grant. The
// namespaces claim is fixed when a token is minted, so a token issued before
// the user got a new sandbox does not cover it for up to an hour; passmower
// asks platform-manager again on every grant, refreshes included.
export async function getValidAccessToken(
  session: IronSession<SessionData>,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<string | null> {
  if (!session.accessToken) {
    return null
  }

  // Found dead by a platform-manager grant: the cached access token would
  // still work, but the session cannot outlive it, so end it now rather than
  // leave the user with half the app failing until it expires.
  if (deadRefreshTokens.has(session.refreshToken)) {
    await destroySessionIfWritable(session)
    return null
  }

  if (!fresh && !isAccessTokenExpired(session)) {
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
  } catch (error) {
    if (isDeadTokenError(error)) deadRefreshTokens.mark(session.refreshToken)
    if (logOAuthFailure("token refresh", error)) {
      await session.destroy()
      return null
    }
    // An unreachable IdP is no reason to fail a request the cached token
    // still covers; only an optional refresh lands here with one.
    return isAccessTokenExpired(session) ? null : session.accessToken
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
// Only a dead refresh token ends the session here. Any other failure leaves
// it alone — the driftmower-api token may still be perfectly valid, so the
// caller just answers 401 for the platform-manager routes.
export async function getPlatformManagerToken(session: IronSession<SessionData>): Promise<string | null> {
  if (!session.refreshToken) {
    return null
  }

  if (deadRefreshTokens.has(session.refreshToken)) {
    await destroySessionIfWritable(session)
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
    logOAuthFailure("platform-manager token grant", error)
    if (isDeadTokenError(error)) {
      deadRefreshTokens.mark(session.refreshToken)
      await destroySessionIfWritable(session)
    }
    return null
  }
}
