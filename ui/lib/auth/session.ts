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
  pmAccessToken?: string
  // Epoch seconds.
  pmExpiresAt?: number
  claims?: SessionClaims
  codeVerifier?: string
  state?: string
  returnTo?: string
}

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "driftmower_session"

export function getSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET

  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters")
  }

  return {
    password,
    cookieName: SESSION_COOKIE_NAME,
    // Matches passmower's refresh-token lifetime.
    ttl: 60 * 60 * 24 * 14,
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
