import { getIronSession } from "iron-session"
import { NextResponse, type NextRequest } from "next/server"

import { getSessionOptions, type SessionData } from "@/lib/auth/session"

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl

  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next()
  }

  const res = NextResponse.next()
  const session = await getIronSession<SessionData>(req, res, getSessionOptions())

  if (session.accessToken) {
    return res
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 })
  }

  const loginUrl = new URL("/api/auth/login", req.url)
  loginUrl.searchParams.set("returnTo", `${pathname}${search}`)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Static assets match by file extension, not by "contains a dot": image
  // routes carry a registry hostname and would skip the session check.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|socket\\.io|.*\\.(?:ico|png|jpg|jpeg|gif|webp|avif|svg|css|js|mjs|map|txt|xml|woff|woff2|ttf|otf)$).*)",
  ],
}
