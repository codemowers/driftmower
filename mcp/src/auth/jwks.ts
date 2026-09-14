import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'

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

export function createJwksResolver(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: FETCH_TIMEOUT_MS })
}
