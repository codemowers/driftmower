import { NextResponse } from "next/server"

import { getOidcRuntimeConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"

export const dynamic = "force-dynamic"

export async function POST() {
  const session = await getSession()
  session.destroy()

  return NextResponse.redirect(
    new URL("/api/auth/login?prompt=login", getOidcRuntimeConfig().appBaseUrl),
    303,
  )
}
