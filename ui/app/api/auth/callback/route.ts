import { NextResponse, type NextRequest } from "next/server"
import * as oidc from "openid-client"

import { getOidcConfig, getOidcRuntimeConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"
import { applyTokens } from "@/lib/auth/tokens"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const { resource, redirectUri, appBaseUrl } = getOidcRuntimeConfig()
  const session = await getSession()
  const { codeVerifier, state, returnTo } = session

  if (!codeVerifier || !state) {
    return NextResponse.redirect(new URL("/api/auth/login", appBaseUrl))
  }

  const config = await getOidcConfig()

  // Behind the TLS-terminating proxy, req.url carries the internal scheme/host,
  // so the callback URL must be rebuilt from the configured external redirect URI.
  const callbackUrl = new URL(redirectUri)
  callbackUrl.search = new URL(req.url).search

  try {
    const tokens = await oidc.authorizationCodeGrant(
      config,
      callbackUrl,
      { pkceCodeVerifier: codeVerifier, expectedState: state },
      { resource }
    )

    applyTokens(session, tokens)
    session.codeVerifier = undefined
    session.state = undefined
    session.returnTo = undefined
    await session.save()

    return NextResponse.redirect(new URL(returnTo || "/", appBaseUrl))
  } catch (error) {
    session.codeVerifier = undefined
    session.state = undefined
    await session.save()

    const detail = error instanceof Error ? error.message : "authorization failed"

    return NextResponse.json({ error: "authentication failed", detail }, { status: 401 })
  }
}
