import { Agent, type Dispatcher } from "undici"

const noKeepAliveAgent = new Agent({
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  pipelining: 0,
  connect: { timeout: 5_000 },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
})

type FetchInit = RequestInit & { dispatcher?: Dispatcher }

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

export async function proxyRequest(req: Request, upstreamUrl: string): Promise<Response> {
  const incoming = new URL(req.url)
  const target = new URL(upstreamUrl)
  incoming.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value)
  })

  const init: FetchInit = {
    method: req.method,
    headers: filterHeaders(req.headers),
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
    return Response.json(
      { error: "upstream unreachable", cause: String(e) },
      { status: 502 },
    )
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterHeaders(upstream.headers),
  })
}

export function backendUrl(): string {
  return process.env.BACKEND_URL ?? "http://driftmower-be:3030"
}

export function explorerUrl(): string {
  return process.env.EXPLORER_URL ?? "http://driftmower-explorer"
}
