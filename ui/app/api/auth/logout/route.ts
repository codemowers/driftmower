import { NextResponse } from "next/server"
import * as oidc from "openid-client"

import { getOidcConfig, getOidcRuntimeConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"
import { describeOAuthError } from "@/lib/auth/tokens"

export const dynamic = "force-dynamic"

export async function POST() {
  const session = await getSession()
  const { refreshToken } = session

  if (refreshToken) {
    try {
      await oidc.tokenRevocation(await getOidcConfig(), refreshToken, { token_type_hint: "refresh_token" })
    } catch (error) {
      const { detail, cause } = describeOAuthError(error)
      console.warn(`[auth] refresh token revocation failed: ${detail}${cause ? ` (cause: ${cause})` : ""}`)
    }
  }

  session.destroy()

  return NextResponse.redirect(
    new URL("/api/auth/login?prompt=login", getOidcRuntimeConfig().appBaseUrl),
    303,
  )
}
