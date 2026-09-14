import "server-only"

import { createRemoteJWKSet, jwtVerify } from "jose"
import type { JWTPayload, JWTVerifyGetKey } from "jose"

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
    const { payload } = await jwtVerify(token, keySet(issuer), {
      issuer,
      audience: mcpAudience(),
      algorithms: ["RS256"],
      clockTolerance: 60,
    })

    if (!payload.sub) return { ok: false, reason: "token has no sub claim" }

    return { ok: true, caller: projectCaller(payload) }
  } catch (error) {
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

// jose's own remote key set, which handles fetch caching, a cooldown, and
// refetching when a token arrives with an unknown kid (key rotation).
//
// provisioning.md records passmower's jwks_uri as returning keys with no kid,
// which would need thumbprint stamping. That is not what the published
// endpoint does: oidc-provider stamps the RFC 7638 thumbprint when registering
// a key (initialize_keystore.js, `key.kid ??= calculateKid(key)`), so the
// document carries a kid even though oidc-key-manager's configured key has
// none. Verified against a real oidc-provider 9.12.2 with a bare key of that
// shape, including `algorithms: ["RS256"]` against a published key with no alg.
//
// The doc's claim describes passmower's *internal* path, which reads the raw
// OIDC_JWKS env var rather than the endpoint. Do not reinstate a workaround
// here without first checking `curl $OIDC_IDP_URI/jwks`.
let cachedKeySet: { uri: string; getKey: JWTVerifyGetKey } | null = null

function keySet(issuer: string): JWTVerifyGetKey {
  const jwksUri = process.env.OIDC_JWKS_URI || `${issuer.replace(/\/+$/, "")}/jwks`

  if (cachedKeySet?.uri !== jwksUri) {
    cachedKeySet = {
      uri: jwksUri,
      getKey: createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5000 }),
    }
  }

  return cachedKeySet.getKey
}
