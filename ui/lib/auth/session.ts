import "server-only"

import { getIronSession, type IronSession, type SessionOptions } from "iron-session"

export interface SessionClaims {
  sub: string
  name?: string
  email?: string
  groups: string[]
}

export interface SessionData {
  accessToken?: string
  refreshToken?: string
  // Epoch seconds.
  expiresAt?: number
  // Second RFC 8707 resource-scoped access token, minted on demand for the
  // platform-manager (tenancy control plane) API.
  // Epoch seconds.
  claims?: SessionClaims
  // Epoch seconds.
  createdAt?: number
  lastSeenAt?: number
  codeVerifier?: string
  state?: string
  returnTo?: string
}

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "driftmower_session"

export const SESSION_IDLE_SECONDS = 24 * 60 * 60
export const SESSION_MAX_SECONDS = 3 * 24 * 60 * 60

export function getSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET

  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters")
  }

  return {
    password,
    cookieName: SESSION_COOKIE_NAME,
    ttl: SESSION_MAX_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
  }
}

// next/headers is imported dynamically so this module stays importable
// from edge middleware.
export async function getSession(): Promise<IronSession<SessionData>> {
  const { cookies } = await import("next/headers")

  return getIronSession<SessionData>(await cookies(), getSessionOptions())
}

// Catches the SESSION_SECRET throw so callers get a 401 rather than a 500.
export async function hasSession(): Promise<boolean> {
  try {
    const session = await getSession()
    return Boolean(session.claims?.sub)
  } catch (error) {
    console.error(`[auth] session check failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
