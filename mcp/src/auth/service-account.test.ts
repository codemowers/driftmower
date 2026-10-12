import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { BearerAuthenticator } from './bearer.js'
import { withServiceAccountAuthentication } from './service-account.js'
import { kubernetesIdentityFor } from './kubernetes-identity.js'

const resource = 'https://mcp.example/mcp'
const username = 'system:serviceaccount:tenant-a:agent-worker'
const groups = ['system:serviceaccounts', 'system:serviceaccounts:tenant-a', 'system:authenticated']
const token = (aud = resource) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: username, aud, exp: 9999999999 })).toString('base64url')}.signature`
const denied = {
  ok: false as const,
  status: 401 as const,
  error: 'invalid_token' as const,
  description: 'Denied'
}

function setup() {
  const oidc: BearerAuthenticator = {
    authenticate: vi.fn(async () => denied),
    challengeHeader: () => '',
    protectedResourceMetadata: () => ({ resource })
  }
  const review = vi.fn(async () => ({ authenticated: true, username, groups, audiences: [resource] }))

  return { oidc, review, auth: withServiceAccountAuthentication(oidc, review, resource) }
}

describe('projected ServiceAccount authentication', () => {
  it('uses reviewed machine identity without OIDC prefixes or namespace claims', async () => {
    const { auth, review } = setup(),
      bearer = token()
    const result = await auth.authenticate({ authorization: `Bearer ${bearer}` })

    expect(review).toHaveBeenCalledWith(bearer, [resource])
    expect(result.ok).toBe(true)

    if (!result.ok) throw Error('Authentication failed')

    expect(result.authInfo.extra?.namespaces).toBeUndefined()
    expect(
      kubernetesIdentityFor(result.authInfo, {
        usernameClaim: 'email',
        usernamePrefix: 'oidc:',
        groupsClaim: 'groups',
        groupsPrefix: 'oidc:'
      })
    ).toEqual({ ok: true, identity: { user: username, groups: expect.arrayContaining(groups) } })
  })
  it('rejects Kubernetes API audience tokens before reviewing them', async () => {
    const { auth, review } = setup()

    expect(
      (await auth.authenticate({ authorization: `Bearer ${token('https://kubernetes.default.svc')}` })).ok
    ).toBe(false)
    expect(review).not.toHaveBeenCalled()
  })
  it.each([{ authenticated: false }, { audiences: [] }, { groups: [] }, { username: 'oidc:someone' }])(
    'rejects an inconclusive or non-ServiceAccount review %j',
    async status => {
      const { auth, review } = setup()

      review.mockResolvedValue({ ...(await review()), ...status })
      expect((await auth.authenticate({ authorization: `Bearer ${token()}` })).ok).toBe(false)
    }
  )
  it('fails closed when TokenReview is unavailable and keeps OIDC as a separate path', async () => {
    const { auth, review, oidc } = setup()

    review.mockRejectedValue(Error('Unavailable'))
    expect((await auth.authenticate({ authorization: `Bearer ${token()}` })).ok).toBe(false)
    await auth.authenticate({ authorization: 'Bearer not-a-machine-token' })
    expect(oidc.authenticate).toHaveBeenCalledOnce()
  })
})
