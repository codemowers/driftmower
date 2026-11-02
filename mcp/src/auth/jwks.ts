import { readFile } from 'node:fs/promises'
import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from 'jose'

// Resolves passmower's signing keys.
//
// Deliberately a thin wrapper around jose's own remote key set, which already
// handles fetch caching, a cooldown, and refetching when a token arrives with
// an unknown `kid` (i.e. key rotation).
//
// This previously stamped RFC 7638 thumbprints onto the fetched keys, because
// driftmower-ui/provisioning.md records passmower's `jwks_uri` as returning
// keys with no `kid`, which would make jose match nothing. That is not what
// happens, and the workaround has been removed. Verified against a real
// oidc-provider 9.12.2 (what passmower ships) configured with a bare key of
// exactly the shape oidc-key-manager generates:
//
//   * `initialize_keystore.js` does `key.kid ??= calculateKid(key)` when
//     registering a key, so the *published* JWKS carries a `kid` — the RFC 7638
//     thumbprint — even though the configured key does not.
//   * `createRemoteJWKSet` against that endpoint verifies, including with
//     `algorithms: ['RS256']` against a published key that carries no `alg`.
//
// The confusion is between two different inputs. passmower's own
// `src/utils/session/bearer-account.js` does stamp thumbprints, because it
// reads the raw `OIDC_JWKS` env var — the *configured* keys, before
// oidc-provider ever sees them. A resource server reads the published endpoint
// instead and needs none of it.
//
// If a token ever does fail here with JWKSNoMatchingKey, look at the published
// document before reinstating a workaround: `curl $OIDC_ISSUER/jwks`.

const FETCH_TIMEOUT_MS = 5000

export function deriveJwksUri(issuer: string, jwksUri?: string): string {
  if (jwksUri) {
    return jwksUri
  }

  // Matches driftmower-be's default, which is passmower's actual layout.
  return `${issuer.replace(/\/+$/, '')}/jwks`
}

export interface JwksResolverOptions {
  // Present the token in this file as a bearer credential when fetching the
  // key set. Needed when the issuer is a Kubernetes apiserver running with
  // --anonymous-auth=false (Talos, CIS-hardened clusters): its
  // /openid/v1/jwks then answers only authenticated requests, and a
  // ServiceAccount may read it through system:service-account-issuer-discovery.
  // The file is re-read on every fetch so projected-token rotation works.
  bearerTokenFile?: string | null
}

export function createJwksResolver(jwksUri: string, options: JwksResolverOptions = {}): JWTVerifyGetKey {
  const tokenFile = options.bearerTokenFile

  return createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: FETCH_TIMEOUT_MS,
    ...(tokenFile
      ? {
          [customFetch]: async (url: string, init: RequestInit) => {
            const token = (await readFile(tokenFile, 'utf8')).trim()
            const headers = new Headers(init.headers)

            headers.set('authorization', `Bearer ${token}`)

            return fetch(url, { ...init, headers })
          }
        }
      : {})
  })
}
