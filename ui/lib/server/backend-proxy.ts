import "server-only"

import { Agent, type Dispatcher } from "undici"

import { getSession } from "@/lib/auth/session"
import { getValidAccessToken } from "@/lib/auth/tokens"

const noKeepAliveAgent = new Agent({
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  pipelining: 0,
  connect: { timeout: 5_000 },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
})

export type FetchInit = RequestInit & { dispatcher?: Dispatcher }

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])

function filterHeaders(headers: Headers): Headers {
  const out = new Headers()
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, value)
  })
  return out
}

// Forwards a request to an upstream with the given bearer token. Shared by
// proxyRequest (driftmower-be) and the platform-manager proxy, which differ
// only in target and in how the token is obtained.
export async function forwardRequest(
  req: Request,
  upstreamUrl: string,
  accessToken: string,
  logPrefix = "be-proxy",
): Promise<Response> {
  const incoming = new URL(req.url)
  const target = new URL(upstreamUrl)
  incoming.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value)
  })

  const headers = filterHeaders(req.headers)
  headers.set("authorization", `Bearer ${accessToken}`)

  const init: FetchInit = {
    method: req.method,
    headers,
    cache: "no-store",
    redirect: "manual",
    dispatcher: noKeepAliveAgent,
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer()
  }

  let upstream: Response
  try {
    upstream = await fetch(target.toString(), init)
  } catch (e) {
    const cause = e instanceof Error && e.cause ? String(e.cause) : String(e)
    console.error(`[${logPrefix}] ${req.method} ${target} -> unreachable: ${cause}`)
    return Response.json(
      { error: "upstream unreachable", cause },
      { status: 502, headers: { "x-proxy-unreachable": "1" } },
    )
  }

  if (upstream.status >= 500) {
    console.error(`[${logPrefix}] ${req.method} ${target} -> ${upstream.status} ${upstream.statusText}`)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterHeaders(upstream.headers),
  })
}

export async function proxyRequest(req: Request, upstreamUrl: string): Promise<Response> {
  const session = await getSession()
  const accessToken = await getValidAccessToken(session)

  if (!accessToken) {
    return Response.json({ error: "not authenticated" }, { status: 401 })
  }

  return forwardRequest(req, upstreamUrl, accessToken)
}

export function backendUrl(): string {
  return process.env.BACKEND_URL ?? "http://driftmower-be:3030"
}
