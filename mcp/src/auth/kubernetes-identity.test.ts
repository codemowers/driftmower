import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { describe, expect, it } from 'vitest'
import { describeIdentity, kubernetesIdentityFor } from './kubernetes-identity.js'

const DEFAULT = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'https://auth.example/#',
  groupsPrefix: ''
}

function authInfo(extra: Record<string, unknown>): AuthInfo {
  return { token: 'verified', clientId: 'mcp', scopes: [], extra }
}

describe('kubernetesIdentityFor', () => {
  it('reproduces the apiserver default mapping: issuer#sub and unprefixed groups', () => {
    expect(
      kubernetesIdentityFor(
        authInfo({
          sub: 'alice',
          groups: ['admins'],
          identityClaims: { username: 'alice', groups: ['admins', 'system:authenticated'] }
        }),
        DEFAULT
      )
    ).toEqual({
      ok: true,
      identity: { user: 'https://auth.example/#alice', groups: ['system:authenticated', 'admins'] }
    })
  })

  it('falls back to sub/groups in extra when no identity claims were captured', () => {
    expect(kubernetesIdentityFor(authInfo({ sub: 'alice', groups: ['devs', 7] }), DEFAULT)).toEqual({
      ok: true,
      identity: { user: 'https://auth.example/#alice', groups: ['system:authenticated', 'devs'] }
    })
  })

  it('maps an email username claim with a custom groups claim and prefixes', () => {
    expect(
      kubernetesIdentityFor(
        authInfo({
          sub: 'alice',
          groups: ['ignored'],
          identityClaims: { username: 'alice@example.com', groups: ['team-a'], emailVerified: true }
        }),
        { usernameClaim: 'email', groupsClaim: 'roles', usernamePrefix: 'oidc:', groupsPrefix: 'oidc:' }
      )
    ).toEqual({
      ok: true,
      identity: { user: 'oidc:alice@example.com', groups: ['system:authenticated', 'oidc:team-a'] }
    })
  })

  it('refuses an unverified email username, as the apiserver would', () => {
    expect(
      kubernetesIdentityFor(
        authInfo({ sub: 'alice', identityClaims: { username: 'alice@example.com', emailVerified: false } }),
        { ...DEFAULT, usernameClaim: 'email', usernamePrefix: '' }
      )
    ).toMatchObject({ ok: false, reason: 'email-unverified' })
  })

  it('names the env var when the configured username claim is absent from the token', () => {
    expect(
      kubernetesIdentityFor(authInfo({ sub: 'alice', identityClaims: { groups: [] } }), {
        ...DEFAULT,
        usernameClaim: 'preferred_username'
      })
    ).toMatchObject({
      ok: false,
      reason: 'claim-missing',
      detail: expect.stringContaining('KUBERNETES_USERNAME_CLAIM')
    })
  })

  it('refuses an unauthenticated context', () => {
    expect(kubernetesIdentityFor(undefined, DEFAULT)).toMatchObject({ ok: false, reason: 'unauthenticated' })
    expect(kubernetesIdentityFor(authInfo({ sub: '' }), DEFAULT)).toMatchObject({
      ok: false,
      reason: 'unauthenticated'
    })
  })

  it('describes an identity without the implicit group', () => {
    expect(describeIdentity({ user: 'issuer#alice', groups: ['system:authenticated', 'admins'] })).toBe(
      'Kubernetes user "issuer#alice" with groups admins'
    )
    expect(describeIdentity({ user: 'issuer#alice', groups: ['system:authenticated'] })).toBe(
      'Kubernetes user "issuer#alice"'
    )
  })
})
