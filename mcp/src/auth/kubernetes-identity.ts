import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { KubernetesIdentity } from '../clients/observability-kubernetes.js'

// The one place a verified token becomes a Kubernetes subject.
//
// kube-apiserver maps an OIDC token to a username with
// `--oidc-username-claim` + `--oidc-username-prefix` and to groups with
// `--oidc-groups-claim` + `--oidc-groups-prefix`. Every SubjectAccessReview this
// server sends must reproduce that mapping exactly, or the apiserver answers
// confidently about a user that does not exist. The four values are therefore
// configuration, never inferred, and the defaults reproduce the apiserver's own
// defaults (claim `sub`, prefix `<issuer>#`, groups unprefixed).
//
// Identity comes only from the verified transport context, never from tool
// arguments or caller-supplied claims.
export interface KubernetesIdentityMapping {
  usernameClaim: string
  groupsClaim: string
  usernamePrefix: string
  groupsPrefix: string
}

export type IdentityResolution =
  | { ok: true; identity: KubernetesIdentity }
  | { ok: false; reason: 'unauthenticated' | 'claim-missing' | 'email-unverified'; detail: string }

export function kubernetesIdentityFor(
  authInfo: AuthInfo | undefined,
  mapping: KubernetesIdentityMapping
): IdentityResolution {
  const extra = authInfo?.extra

  if (typeof extra?.sub !== 'string' || !extra.sub) {
    return { ok: false, reason: 'unauthenticated', detail: 'The call carries no verified caller identity' }
  }

  // This field is attached only after audience-bound Kubernetes TokenReview.
  // Machine subjects already use Kubernetes names and must not gain OIDC prefixes.
  const machine = extra.kubernetesIdentity as KubernetesIdentity | undefined

  if (
    machine &&
    /^system:serviceaccount:[^:]+:[^:]+$/.test(machine.user) &&
    Array.isArray(machine.groups) &&
    machine.groups.every(group => typeof group === 'string')
  ) {
    return { ok: true, identity: { user: machine.user, groups: [...machine.groups] } }
  }

  const claims = readIdentityClaims(extra.identityClaims)
  // Older transports (and tests) put only sub/groups in `extra`; the default
  // mapping reads exactly those, so fall back rather than refuse.
  const username = claims?.username ?? (mapping.usernameClaim === 'sub' ? extra.sub : undefined)
  const groups = claims?.groups ?? (mapping.groupsClaim === 'groups' ? readStrings(extra.groups) : [])

  if (!username) {
    return {
      ok: false,
      reason: 'claim-missing',
      detail:
        `The access token carries no '${mapping.usernameClaim}' claim; ` +
        'KUBERNETES_USERNAME_CLAIM must name a claim present in access tokens'
    }
  }

  // kube-apiserver refuses an email username unless the token says it is
  // verified; answering for it here would be answering for nobody.
  if (mapping.usernameClaim === 'email' && claims?.emailVerified === false) {
    return {
      ok: false,
      reason: 'email-unverified',
      detail:
        'The access token marks its email claim unverified, which Kubernetes does not accept as a username'
    }
  }

  return {
    ok: true,
    identity: {
      user: `${mapping.usernamePrefix}${username}`,
      // The apiserver adds system:authenticated to every principal; an OIDC
      // caller is never a ServiceAccount, so no system:serviceaccounts groups.
      groups: [
        ...new Set(['system:authenticated', ...groups.map(group => `${mapping.groupsPrefix}${group}`)])
      ]
    }
  }
}

export function describeIdentity(identity: KubernetesIdentity): string {
  const groups = identity.groups.filter(group => group !== 'system:authenticated')

  return `Kubernetes user "${identity.user}"${groups.length > 0 ? ` with groups ${groups.join(', ')}` : ''}`
}

export interface IdentityClaims {
  username?: string
  groups?: string[]
  emailVerified?: boolean
}

function readIdentityClaims(value: unknown): IdentityClaims | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>

  return {
    username: typeof record.username === 'string' && record.username ? record.username : undefined,
    groups: Array.isArray(record.groups) ? readStrings(record.groups) : undefined,
    emailVerified: typeof record.emailVerified === 'boolean' ? record.emailVerified : undefined
  }
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
