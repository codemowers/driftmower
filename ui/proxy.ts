import { getIronSession } from "iron-session"
import { NextResponse, type NextRequest } from "next/server"

import { getSessionOptions, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS, type SessionData } from "@/lib/auth/session"
import { SESSION_ENDED_HEADER } from "@/lib/cluster/constants"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const LAST_SEEN_RESOLUTION_SECONDS = 5 * 60
const TOKEN_REFRESH_WINDOW_SECONDS = 2 * 60

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isCrossSiteWrite(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false

  const origin = req.headers.get("origin")
  if (origin) {
    try {
      return new URL(origin).host !== req.headers.get("host")
    } catch {
      return true
    }
  }

  const site = req.headers.get("sec-fetch-site")
  return site !== null && site !== "same-origin" && site !== "none"
}

function sessionEnded(session: SessionData, now: number): boolean {
  if (!session.accessToken) return true
  if (!session.createdAt || !session.lastSeenAt) return true
  return now - session.createdAt > SESSION_MAX_SECONDS || now - session.lastSeenAt > SESSION_IDLE_SECONDS
}

function shouldTouch(session: SessionData, now: number): boolean {
  const tokenSettled = (session.expiresAt ?? 0) - now > TOKEN_REFRESH_WINDOW_SECONDS
  return tokenSettled && now - (session.lastSeenAt ?? 0) > LAST_SEEN_RESOLUTION_SECONDS
}

function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development"
  const issuer = process.env.OIDC_IDP_URI ? new URL(process.env.OIDC_IDP_URI).origin : ""
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${issuer}`.trim(),
    "frame-ancestors 'none'",
  ].join("; ")
}

function nextWithPolicy(req: NextRequest, isApi: boolean): NextResponse {
  if (isApi) return NextResponse.next()

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const policy = contentSecurityPolicy(nonce)
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", policy)

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set("Content-Security-Policy", policy)
  return res
}

async function endSession(req: NextRequest, isApi: boolean, hadSession: boolean): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl
  let res: NextResponse

  if (isApi) {
    res = NextResponse.json({ error: hadSession ? "session expired" : "not authenticated" }, { status: 401 })
    res.headers.set(SESSION_ENDED_HEADER, "1")
  } else {
    const loginUrl = new URL("/api/auth/login", req.url)
    loginUrl.searchParams.set("returnTo", `${pathname}${search}`)
    res = NextResponse.redirect(loginUrl)
  }

  if (hadSession) {
    const stale = await getIronSession<SessionData>(req, res, getSessionOptions())
    stale.destroy()
  }
  return res
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isApi = pathname.startsWith("/api/")

  if (isCrossSiteWrite(req)) {
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 })
  }

  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next()
  }

  const res = nextWithPolicy(req, isApi)
  const session = await getIronSession<SessionData>(req, res, getSessionOptions())
  const now = nowSeconds()

  if (sessionEnded(session, now)) {
    return endSession(req, isApi, Boolean(session.accessToken))
  }

  if (shouldTouch(session, now)) {
    session.lastSeenAt = now
    await session.save()
  }

  return res
}

export const config = {
  // Static assets match by file extension, not by "contains a dot": image
  // routes carry a registry hostname and would skip the session check.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|socket\\.io|.*\\.(?:ico|png|jpg|jpeg|gif|webp|avif|svg|css|js|mjs|map|txt|xml|woff|woff2|ttf|otf)$).*)",
  ],
}
