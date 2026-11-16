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

export async function fetchWithContext(operation: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (error) {
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
