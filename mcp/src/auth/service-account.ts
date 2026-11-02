import { decodeJwt } from 'jose'
import type { BearerAuthenticator, RejectedCall } from './bearer.js'
import { readBearerToken } from './bearer.js'

export interface ServiceAccountReview {
  authenticated: boolean
  username: string | null
  groups: string[]
  audiences: string[]
}

// TokenReview, not unverified JWT claims, establishes the machine identity.
// The resource audience prevents ordinary Kubernetes API tokens opening MCP.
export function withServiceAccountAuthentication(
  oidc: BearerAuthenticator,
  review: (token: string, audiences: string[]) => Promise<ServiceAccountReview>,
  resource: string
): BearerAuthenticator {
  const denied: RejectedCall = {
    ok: false,
    status: 401,
    error: 'invalid_token',
    description: 'A valid ServiceAccount token bound to this MCP resource is required'
  }

  return {
    ...oidc,
    async authenticate(headers) {
      const token = readBearerToken(headers.authorization)
      let claims

      try {
        claims = token ? decodeJwt(token) : undefined
      } catch {
        /* OIDC handles malformed tokens. */
      }

      if (!token || !claims?.sub?.startsWith('system:serviceaccount:')) return oidc.authenticate(headers)

      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]

      if (!audiences.includes(resource)) return denied

      try {
        const verified = await review(token, [resource])
        const identity = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(verified.username || '')

        if (
          !verified.authenticated ||
          !identity ||
          !verified.audiences.includes(resource) ||
          !verified.groups.includes(`system:serviceaccounts:${identity[1]}`)
        )
          return denied

        const groups = [...new Set(['system:authenticated', ...verified.groups])]

        return {
          ok: true,
          caller: {
            sub: verified.username!,
            groups,
            identityClaims: { username: verified.username!, groups }
          },
          authInfo: {
            token,
            clientId: 'kubernetes-serviceaccount',
            scopes: [],
            resource: new URL(resource),
            expiresAt: claims.exp,
            extra: { sub: verified.username, groups, kubernetesIdentity: { user: verified.username, groups } }
          }
        }
      } catch {
        return denied
      }
    }
  }
}
