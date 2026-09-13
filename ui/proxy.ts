import { getIronSession } from "iron-session"
import { NextResponse, type NextRequest } from "next/server"

import { getSessionOptions, type SessionData } from "@/lib/auth/session"

const PROVISIONING_CAPABILITIES_PATH = "/api/provisioning/capabilities"

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl

  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next()
  }

  // The provisioning capability route also serves driftmower-mcp, the platform's
  // MCP gateway, whose callers hold a bearer token and no session cookie. Let
  // those through so the route can do its own token verification; without this
  // they would get this middleware's 401 JSON before the route ever ran.
  //
  // Exact match, and only when a bearer is actually present: a prefix match
  // would un-gate sibling routes, and skipping the cookie check for cookieless
  // requests generally would un-gate the route for anyone.
  if (pathname === PROVISIONING_CAPABILITIES_PATH && req.headers.get("authorization")) {
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
