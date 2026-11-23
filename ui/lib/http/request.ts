import { beginDownload, responseSize } from "./downloads.ts"

// Include the failing operation and endpoint without exposing URL credentials,
// query parameters, bearer headers or request arguments in notices.
export function requestTarget(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input)
  try {
    const url = new URL(raw, "http://relative.invalid")
    return `${url.origin === "http://relative.invalid" ? "" : url.origin}${url.pathname}`
  } catch {
    return "invalid endpoint"
  }
}

class RequestFailure extends Error {}

export function requestError(error: unknown, operation: string, input: RequestInfo | URL, method?: string): Error {
  if (error instanceof Error && (error.name === "AbortError" || error instanceof RequestFailure)) return error
  const reason = (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s"'<>]+/g, url => requestTarget(url))
  return new RequestFailure(`${operation} failed (${method ? method + " " : ""}${requestTarget(input)}): ${reason}`, {cause: error})
}

// Native desktop configuration and control requests are local bookkeeping,
// not cluster downloads. Keep port-forwarded MCP/data responses measurable.
function desktopControlRequest(input: RequestInfo | URL): boolean {
  const origin = typeof location === "undefined" ? "http://relative.invalid" : location.origin
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    return url.origin === origin && (url.pathname === "/dashboard-config.json" ||
      url.pathname.startsWith("/api/desktop/") || url.pathname === "/api/kubernetes-sign-in")
  } catch { return false }
}

export async function fetchWithContext(operation: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // The MCP GET subscription is intentionally long-lived and is not a view load.
  const progress = (operation === "MCP update stream" || desktopControlRequest(input)) ? null : beginDownload()
  try {
    const response = await fetch(input, init)
    if (!progress) return response
    if ([204, 205, 304].includes(response.status) || !response.body || !response.ok || response.headers.get("Content-Length") === "0") {
      progress.finish()
      return response
    }
    const total = responseSize(response)
    if (total !== null) progress.size(total)
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) { progress.finish(); reader.releaseLock(); controller.close(); return }
          progress.add(value.byteLength)
          controller.enqueue(value)
        } catch (error) { progress.finish(); reader.releaseLock(); controller.error(error) }
      },
      async cancel(reason) {
        try { await reader.cancel(reason) } finally { progress.finish(); reader.releaseLock() }
      },
    }, { highWaterMark: 0 })
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    for (const property of ["url", "redirected", "type"] as const) {
      Object.defineProperty(wrapped, property, { value: response[property] })
    }
    return wrapped
  } catch (error) {
    progress?.finish()
    if (init?.signal?.aborted) throw error
    throw requestError(error, operation, input, init?.method ?? (input instanceof Request ? input.method : "GET"))
  }
}

export function mcpOperation(init?: RequestInit): string {
  if (init?.method === "GET") return "MCP update stream"
  if (typeof init?.body !== "string") return "MCP request"
  let payload: {method?: string; params?: {name?: string}}
  try {
    payload = JSON.parse(init.body)
  } catch {
    return "MCP request"
  }
  if (payload?.method === "tools/call" && typeof payload.params?.name === "string") return `MCP tool ${payload.params.name}`
  return typeof payload?.method === "string" ? `MCP ${payload.method}` : "MCP request"
}
