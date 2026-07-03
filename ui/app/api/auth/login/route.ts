import { NextResponse, type NextRequest } from "next/server"
import * as oidc from "openid-client"

import { getOidcConfig, getOidcRuntimeConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const config = await getOidcConfig()
  const { redirectUri, scope, resource } = getOidcRuntimeConfig()

  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const state = oidc.randomState()

  const session = await getSession()
  session.codeVerifier = codeVerifier
  session.state = state

  const returnTo = req.nextUrl.searchParams.get("returnTo")
  session.returnTo = returnTo && returnTo.startsWith("/") ? returnTo : "/"
  await session.save()

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    resource,
    ...(req.nextUrl.searchParams.get("prompt") === "login"
      ? { prompt: "login" }
      : {}),
  })

  return NextResponse.redirect(authorizationUrl)
}
