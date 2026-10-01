// Reads the provisioning capability layer from driftmower-mcp, which now owns
// it: every fact is read there from Kubernetes, and every permission answer is
// a SubjectAccessReview asked as the calling user. This app only relays.
//
// Kept free of server imports so the error mapping is testable without Next.

import type { CapabilityResponse } from "./types"

export const MCP_CAPABILITIES_PATH = "/api/provisioning/capabilities"

export type McpCapabilitiesResult =
  | { ok: true; body: CapabilityResponse }
  // Every failure is a 4xx on purpose: this app is served through Cloudflare,
  // which replaces the body of an origin 5xx with its own HTML page, and these
  // explanations are meant to reach the browser.
  | { ok: false; status: 400 | 401 | 424; body: { error: string; detail: string } }

export async function fetchCapabilitiesFromMcp(options: {
  baseUrl: string
  accessToken: string
  namespaces: string[]
  offering: string | null
  timeoutMs?: number
  fetchImplementation?: typeof fetch
}): Promise<McpCapabilitiesResult> {
  const url = new URL(`${options.baseUrl.replace(/\/+$/, "")}${MCP_CAPABILITIES_PATH}`)

  if (options.namespaces.length > 0) url.searchParams.set("ns", options.namespaces.join(","))
  if (options.offering) url.searchParams.set("offering", options.offering)

  let response: Response

  try {
    response = await (options.fetchImplementation ?? fetch)(url, {
      headers: { accept: "application/json", authorization: `Bearer ${options.accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
  } catch (error) {
    return failure(424, "mcp_unreachable", `driftmower-mcp could not be reached at ${url.origin}: ${messageOf(error)}`)
  }

  const text = await response.text()
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 200)
    return failure(424, "mcp_bad_response", `driftmower-mcp answered HTTP ${response.status} with a body that is not JSON: ${snippet}`)
  }

  if (response.ok) return { ok: true, body: parsed as CapabilityResponse }

  const reported = parsed as { error?: unknown; error_description?: unknown }
  const detail = typeof reported.error_description === "string" ? reported.error_description : `HTTP ${response.status}`

  // A refused token means the session cannot vouch for the user any more (or
  // the audiences disagree); signing in again is the fix the page offers.
  if (response.status === 401 || response.status === 403) {
    return failure(401, typeof reported.error === "string" ? reported.error : "mcp_rejected_token", detail)
  }

  if (response.status === 400) {
    return failure(400, typeof reported.error === "string" ? reported.error : "bad_request", detail)
  }

  return failure(424, typeof reported.error === "string" ? reported.error : "mcp_failed", detail)
}

function failure(status: 400 | 401 | 424, error: string, detail: string): McpCapabilitiesResult {
  return { ok: false, status, body: { error, detail } }
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  const reason = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : null
  return reason ? `${message} (${reason})` : message
}
