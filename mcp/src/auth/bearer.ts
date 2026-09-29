import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { JWTVerifyGetKey } from 'jose'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { createJwksResolver } from './jwks.js'
import { verifyAccessToken, type AuthenticatedCaller } from './verify-access-token.js'

export interface BearerAuthConfig {
  issuer: string
  jwksUri: string
  // The RFC 8707 resource indicator this server was issued for, matched
  // strictly against `aud`. Strictness is load-bearing: without it the ordinary
  // UI access token that any browser session holds would open this server.
  //
  // Leave it unset unless something upstream mints for a different indicator.
  // The default is the `resource` this server advertises, and that is the only
  // value a conformant client can end up asking for: it reads the RFC 9728
  // metadata below and passes `resource` verbatim, and an authorization server
  // honouring RFC 8707 puts that same string in `aud`. Anything else here
  // rejects every token the flow is able to produce.
  audience?: string
  // Public URL of this server, used to build the resource_metadata pointer on
  // 401s. That header is how an OAuth-capable client discovers the flow at all.
  publicUrl: string
  namespacesClaim?: string
  // See AccessTokenVerificationOptions.identityClaims.
  identityClaims?: { username: string; groups: string }
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
  const audience = config.audience ?? resource

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
          audience,
          namespacesClaim: config.namespacesClaim,
          identityClaims: config.identityClaims
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
              namespaces: caller.namespaces,
              identityClaims: caller.identityClaims
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
        // A client requests exactly what is listed here, so `offline_access`
        // has to be among them: without it passmower issues no refresh token
        // and the connection dies an hour after every sign-in. The OIDCClient
        // already grants the scope and the `refresh_token` grant; this document
        // was the only thing withholding it.
        scopes_supported: ['openid', 'profile', 'email', 'groups', 'namespaces', 'offline_access']
      }
    }
  }
}

// The RFC 6750 rejection: a JSON body plus the WWW-Authenticate challenge that
// points an OAuth-capable client at the resource metadata.
export function writeChallenge(
  response: ServerResponse,
  authenticator: BearerAuthenticator,
  outcome: RejectedCall
): void {
  response.writeHead(outcome.status, {
    'content-type': 'application/json',
    'www-authenticate': authenticator.challengeHeader(outcome)
  })
  response.end(JSON.stringify({ error: outcome.error, error_description: outcome.description }))
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
