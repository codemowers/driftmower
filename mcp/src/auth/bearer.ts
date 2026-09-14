import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { JWTVerifyGetKey } from 'jose'
import type { IncomingHttpHeaders } from 'node:http'
import { createJwksResolver } from './jwks.js'
import { verifyAccessToken, type AuthenticatedCaller } from './verify-access-token.js'

export interface BearerAuthConfig {
  issuer: string
  jwksUri: string
  // The RFC 8707 resource indicator this server was issued for, matched
  // strictly against `aud`. Strictness is load-bearing: without it the ordinary
  // UI access token that any browser session holds would open this server.
  audience: string
  // Public URL of this server, used to build the resource_metadata pointer on
  // 401s. That header is how an OAuth-capable client discovers the flow at all.
  publicUrl: string
  namespacesClaim?: string
}

export interface AuthorizedCall {
  ok: true
  authInfo: AuthInfo
  caller: AuthenticatedCaller
}

export interface RejectedCall {
  ok: false
  status: 401 | 403
  // RFC 6750 error code, echoed in WWW-Authenticate.
  error: 'invalid_request' | 'invalid_token' | 'insufficient_scope'
  description: string
}

export type AuthOutcome = AuthorizedCall | RejectedCall

export interface BearerAuthenticator {
  authenticate(headers: IncomingHttpHeaders): Promise<AuthOutcome>
  challengeHeader(outcome: RejectedCall): string
  protectedResourceMetadata(): Record<string, unknown>
}

// RFC 9728 locates the document for resource `https://host/mcp` at
// `https://host/.well-known/oauth-protected-resource/mcp` — at the root, with
// the resource path appended.
export function protectedResourceMetadataPath(resourcePath: string): string {
  return `/.well-known/oauth-protected-resource${resourcePath}`
}

export function createBearerAuthenticator(
  config: BearerAuthConfig,
  resourcePath: string,
  getKey: JWTVerifyGetKey = createJwksResolver(config.jwksUri)
): BearerAuthenticator {
  const resource = `${config.publicUrl.replace(/\/+$/, '')}${resourcePath}`
  const metadataUrl = `${config.publicUrl.replace(/\/+$/, '')}${protectedResourceMetadataPath(resourcePath)}`

  return {
    async authenticate(headers) {
      const token = readBearerToken(headers.authorization)

      if (!token) {
        return {
          ok: false,
          status: 401,
          error: 'invalid_request',
          description: 'An Authorization: Bearer <token> header is required'
        }
      }

      try {
        const { caller, payload } = await verifyAccessToken(token, getKey, {
          issuer: config.issuer,
          audience: config.audience,
          namespacesClaim: config.namespacesClaim
        })

        return {
          ok: true,
          caller,
          authInfo: {
            token,
            clientId: readClientId(payload),
            scopes: readScopes(payload),
            expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
            resource: new URL(resource),
            // The SDK hands `extra` through to tool handlers untouched. It is
            // the only safe channel for per-caller identity: the services and
            // the server instance are shared across concurrent requests, so
            // anything stashed at module level would leak between callers.
            extra: {
              sub: caller.sub,
              email: caller.email,
              name: caller.name,
              groups: caller.groups,
              namespaces: caller.namespaces
            }
          }
        }
      } catch (error) {
        return {
          ok: false,
          status: 401,
          error: 'invalid_token',
          description: error instanceof Error ? error.message : String(error)
        }
      }
    },

    challengeHeader(outcome) {
      return `Bearer error="${outcome.error}", error_description="${escapeQuoted(outcome.description)}", resource_metadata="${metadataUrl}"`
    },

    protectedResourceMetadata() {
      return {
        resource,
        authorization_servers: [config.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'profile', 'email', 'groups', 'namespaces']
      }
    }
  }
}

export function readBearerToken(headerValue: string | string[] | undefined): string | null {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue

  if (typeof header !== 'string') {
    return null
  }

  const match = /^Bearer[ ]+(?<token>[^ ]+)[ ]*$/i.exec(header)

  return match?.groups?.token ?? null
}

function readClientId(payload: Record<string, unknown>): string {
  const candidate = payload.azp ?? payload.client_id

  return typeof candidate === 'string' ? candidate : ''
}

function readScopes(payload: Record<string, unknown>): string[] {
  if (typeof payload.scope === 'string') {
    return payload.scope.split(' ').filter(Boolean)
  }

  return Array.isArray(payload.scp)
    ? payload.scp.filter((item): item is string => typeof item === 'string')
    : []
}

// A verification message can carry a quote or a newline; neither may break the
// header it lands in.
function escapeQuoted(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'")
}
