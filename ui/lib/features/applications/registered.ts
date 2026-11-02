import "server-only"

import { getOidcRuntimeConfig } from "@/lib/auth/oidc"
import { getSession } from "@/lib/auth/session"
import { getValidAccessToken } from "@/lib/auth/tokens"
import type { OidcApp } from "./types"

const APPLICATIONS_SCOPE = "applications"

export type RegisteredApps =
  | { state: "ok"; apps: OidcApp[] }
  | { state: "scope-not-configured" }
  | { state: "unauthenticated" }
  | { state: "forbidden" }
  | { state: "error"; message: string }

// Already filtered per user by group, so whatever returns is what this caller may open.
export async function fetchRegisteredApps(): Promise<RegisteredApps> {
  const { issuer, scope } = getOidcRuntimeConfig()

  if (!scope.split(/\s+/).includes(APPLICATIONS_SCOPE)) {
    return { state: "scope-not-configured" }
  }

  const accessToken = await getValidAccessToken(await getSession())
  if (!accessToken) {
    return { state: "unauthenticated" }
  }

  const target = `${issuer.replace(/\/+$/, "")}/api/apps`

  let response: Response
  try {
    response = await fetch(target, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    })
  } catch (e) {
    const cause = e instanceof Error && e.cause ? String(e.cause) : String(e)
    console.error(`[applications] GET ${target} -> unreachable: ${cause}`)
    return { state: "error", message: "passmower unreachable" }
  }

  if (response.status === 403) return { state: "forbidden" }
  if (response.status === 401) return { state: "unauthenticated" }

  if (!response.ok) {
    console.error(`[applications] GET ${target} -> ${response.status} ${response.statusText}`)
    return { state: "error", message: `passmower returned ${response.status}` }
  }

  const body = (await response.json()) as { apps?: OidcApp[] }
  return { state: "ok", apps: body.apps ?? [] }
}
