import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

// Driftmower MCP is a pure OIDC resource server: it never mints tokens, it only
// validates RS256 JWT access tokens issued by the configured provider and
// projects the identity, groups and tenancy claim onto the caller.
//
// This mirrors `verifyAccessToken` in driftmower-be
// (src/authentication/index.ts) on purpose. Both services validate tokens from
// the same issuer, so a difference in claim handling between them would show up
// as one service granting access the other refuses. The key resolver is
// injected rather than constructed here so this stays unit-testable against a
// local JWKS with no network fetch.

// The tenancy claim carrying the namespaces a caller may access. Matches
// DEFAULT_TENANCY_CLAIM in driftmower-be/src/tenancy.ts; the `namespaces` OIDC
// scope in the OIDCClient CR is what puts it into a token.
export const DEFAULT_NAMESPACES_CLAIM = 'codemowers.io/namespaces'

export class AccessTokenVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessTokenVerificationError'
  }
}

export interface AuthenticatedCaller {
  sub: string
  email?: string
  name?: string
  groups: string[]
  // Namespaces the caller may access, projected from the tenancy claim.
  // `undefined` means the token carried no claim at all, which is materially
  // different from an empty array: the first is "we were not told", the second
  // is "told, and the answer is none". Callers must not collapse the two.
  namespaces?: string[]
  // The raw values of the claims kube-apiserver maps to a username and to
  // groups, read under the configured claim names. Kept separate from `sub` and
  // `groups` above, which are what this server itself audits and scopes by.
  identityClaims: {
    username?: string
    groups?: string[]
    emailVerified?: boolean
  }
}

export interface VerifiedAccessToken {
  caller: AuthenticatedCaller
  payload: JWTPayload
}

export interface AccessTokenVerificationOptions {
  issuer: string
  audience: string
  namespacesClaim?: string
  // Claim names kube-apiserver uses for username and groups (its
  // --oidc-username-claim / --oidc-groups-claim). Default sub / groups.
  identityClaims?: { username: string; groups: string }
}

export async function verifyAccessToken(
  accessToken: string,
  getKey: JWTVerifyGetKey,
  options: AccessTokenVerificationOptions
): Promise<VerifiedAccessToken> {
  const { payload } = await jwtVerify(accessToken, getKey, {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: ['RS256'],
    clockTolerance: 60
  })

  if (!payload.sub) {
    throw new AccessTokenVerificationError('Token is missing a sub claim')
  }

  return {
    caller: {
      sub: String(payload.sub),
      email: readString(payload.email),
      name: readString(payload.name),
      groups: readStringArray((payload as Record<string, unknown>).groups) ?? [],
      namespaces: readStringArray(
        (payload as Record<string, unknown>)[options.namespacesClaim ?? DEFAULT_NAMESPACES_CLAIM]
      ),
      identityClaims: {
        username: readClaimAsString(payload, options.identityClaims?.username ?? 'sub'),
        groups: readStringArray(
          (payload as Record<string, unknown>)[options.identityClaims?.groups ?? 'groups']
        ),
        emailVerified: typeof payload.email_verified === 'boolean' ? payload.email_verified : undefined
      }
    },
    payload
  }
}

// A username claim may legitimately be a number in some providers' tokens;
// kube-apiserver stringifies it the same way.
function readClaimAsString(payload: JWTPayload, claim: string): string | undefined {
  const value = (payload as Record<string, unknown>)[claim]

  if (typeof value === 'string') return value || undefined

  if (typeof value === 'number') return String(value)

  return undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.filter((item): item is string => typeof item === 'string')
}
