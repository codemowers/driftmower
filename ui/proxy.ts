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
  // Everything except Next internals, static assets, and the socket.io
  // path (handled by server.js before Next).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|socket.io|.*\\.).*)"],
}
