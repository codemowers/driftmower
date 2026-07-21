import { NextResponse, type NextRequest } from "next/server"
import * as oidc from "openid-client"

import { getOidcConfig, getOidcRuntimeConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"
import { platformManagerAudience } from "@/lib/auth/tokens"

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

  // URLSearchParams so `resource` can repeat: the grant must contain every
  // audience the BFF will later mint tokens for (driftmower-api always;
  // platform-manager-api when that integration is configured) — a refresh
  // grant for a resource outside the original grant fails with invalid_target.
  const authorizationParams = new URLSearchParams({
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  })
  authorizationParams.append("resource", resource)

  if (process.env.PLATFORM_MANAGER_URL) {
    authorizationParams.append("resource", platformManagerAudience())
  }

  if (req.nextUrl.searchParams.get("prompt") === "login") {
    authorizationParams.append("prompt", "login")
  }

  const authorizationUrl = oidc.buildAuthorizationUrl(config, authorizationParams)

  return NextResponse.redirect(authorizationUrl)
}
