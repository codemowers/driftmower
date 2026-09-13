import "server-only"

import { calculateJwkThumbprint, createLocalJWKSet, errors, jwtVerify } from "jose"
import type { JSONWebKeySet, JWTPayload, JWTVerifyGetKey } from "jose"

import { getOidcRuntimeConfig } from "./oidc"

// Bearer-token authentication for routes that serve driftmower-mcp as well as
// the browser.
//
// Why this exists: driftmower-mcp is the platform's single MCP gateway, and it
// is a façade over this app's provisioning capability layer — the Kubernetes
// reads and the RBAC for them live here (k8s/rbac.yaml), so the facts have to
// be served from here. An MCP client holds no session cookie, so the route
// needs a second way in.
//
// The token it presents is minted for the MCP audience, not this app's. That is
// deliberate: driftmower-mcp verifies `aud` strictly so an ordinary UI session
// token cannot open it, which means the token that reaches us carries the MCP
// audience and we must accept exactly that one.

export const DEFAULT_MCP_AUDIENCE = "https://driftmower-mcp"
export const NAMESPACES_CLAIM = "codemowers.io/namespaces"

export function mcpAudience(): string {
  return process.env.MCP_AUDIENCE || DEFAULT_MCP_AUDIENCE
}

export type BearerCaller = {
  sub: string
  email?: string
  name?: string
  groups: string[]
  // Namespaces from the tenancy claim. `undefined` means the token carried no
  // claim at all — materially different from an empty list, and the two must
  // not be collapsed: one is a misconfigured client, the other a caller
  // entitled to nothing.
  namespaces?: string[]
}

export type BearerResult =
  | { ok: true; caller: BearerCaller }
  | { ok: false; reason: string }

export function hasBearerToken(req: Request): boolean {
  return readBearerToken(req) !== null
}

export function readBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization")

  if (!header) return null

  // Numbered group, not named: this project targets ES2017.
  const match = /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(header)

  return match?.[1] ?? null
}

export async function verifyBearer(req: Request): Promise<BearerResult> {
  const token = readBearerToken(req)

  if (!token) return { ok: false, reason: "no bearer token" }

  const { issuer } = getOidcRuntimeConfig()

  try {
    const { payload } = await jwtVerify(token, await keySet(issuer), {
      issuer,
      audience: mcpAudience(),
      algorithms: ["RS256"],
      clockTolerance: 60,
    })

    if (!payload.sub) return { ok: false, reason: "token has no sub claim" }

    return { ok: true, caller: projectCaller(payload) }
  } catch (error) {
    // Key rotation looks like a key miss. Drop the cached set and retry once.
    if (error instanceof errors.JWKSNoMatchingKey) {
      invalidateKeySet()

      try {
        const { payload } = await jwtVerify(token, await keySet(issuer), {
          issuer,
          audience: mcpAudience(),
          algorithms: ["RS256"],
          clockTolerance: 60,
        })

        if (!payload.sub) return { ok: false, reason: "token has no sub claim" }

        return { ok: true, caller: projectCaller(payload) }
      } catch (retryError) {
        return { ok: false, reason: messageOf(retryError) }
      }
    }

    return { ok: false, reason: messageOf(error) }
  }
}

function projectCaller(payload: JWTPayload): BearerCaller {
  const record = payload as Record<string, unknown>

  return {
    sub: String(payload.sub),
    email: typeof record.email === "string" ? record.email : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    groups: stringArray(record.groups) ?? [],
    namespaces: stringArray(record[NAMESPACES_CLAIM]),
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  return value.filter((item): item is string => typeof item === "string")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Deliberately not createRemoteJWKSet, and deliberately not createTtlCache.
//
// passmower's jwks_uri can return keys with no `kid` and no `alg`, while
// oidc-provider signs with the RFC 7638 thumbprint as `kid` — so jose's key
// matching finds no candidate and every token fails. Stamping the thumbprint on
// locally is the fix. createTtlCache has no notion of invalidation, which key
// rotation needs.
const KEY_SET_TTL_MS = 10 * 60 * 1000

let cachedKeySet: { getKey: JWTVerifyGetKey; expiresAt: number } | null = null

function invalidateKeySet(): void {
  cachedKeySet = null
}

async function keySet(issuer: string): Promise<JWTVerifyGetKey> {
  const now = Date.now()

  if (cachedKeySet && cachedKeySet.expiresAt > now) return cachedKeySet.getKey

  const jwksUri = process.env.OIDC_JWKS_URI || `${issuer.replace(/\/+$/, "")}/jwks`
  const response = await fetch(jwksUri, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok) {
    throw new Error(`JWKS request to ${jwksUri} failed with status ${response.status}`)
  }

  const body = (await response.json()) as Partial<JSONWebKeySet>

  if (!Array.isArray(body.keys)) {
    throw new Error(`JWKS response from ${jwksUri} has no keys array`)
  }

  const keys = await Promise.all(
    body.keys.map(async (key) => ({
      ...key,
      kid: key.kid ?? (await calculateJwkThumbprint(key)),
      alg: key.alg ?? "RS256",
    }))
  )

  const getKey = createLocalJWKSet({ keys })

  cachedKeySet = { getKey, expiresAt: now + KEY_SET_TTL_MS }

  return getKey
}
