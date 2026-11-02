import { describe, expect, it, vi } from 'vitest'
import type { RbacScopeResolver } from '../../clients/rbac-scope.js'
import { UNRESTRICTED_SCOPE } from '../../domain/tenancy.js'
import { resolveCallerScope, type ToolCallContext } from './caller-scope.js'

const identityMapping = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'issuer#',
  groupsPrefix: ''
}

function context(extra: Record<string, unknown>): ToolCallContext {
  return { authInfo: { token: 't', clientId: 'c', scopes: [], extra } }
}

function resolver(result: object | Error) {
  const resolve =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result)

  return { resolver: { resolve } as unknown as RbacScopeResolver, resolve }
}

describe('resolveCallerScope', () => {
  it('is unrestricted without a verified caller regardless of policy', async () => {
    const { resolver: rbac, resolve } = resolver({ namespaces: ['a'] })

    expect(await resolveCallerScope(undefined, { policy: 'rbac', resolver: rbac, identityMapping })).toBe(
      UNRESTRICTED_SCOPE
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it('under the claim policy never touches the authorizer', async () => {
    const { resolver: rbac, resolve } = resolver({ namespaces: ['a'] })

    expect(
      await resolveCallerScope(context({ sub: 'alice', namespaces: ['x'] }), {
        policy: 'claim',
        resolver: rbac,
        identityMapping
      })
    ).toEqual({ scope: ['x'], source: 'claim' })
    expect(await resolveCallerScope(context({ sub: 'alice' }))).toEqual({
      scope: [],
      source: 'claim-missing'
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('under union asks the authorizer as the mapped identity, claim namespaces first', async () => {
    const audit = vi.fn()
    const { resolver: rbac, resolve } = resolver({
      namespaces: ['b'],
      unknown: [],
      clusterWide: false,
      truncated: false,
      total: 2
    })

    const scope = await resolveCallerScope(context({ sub: 'alice', groups: ['devs'], namespaces: ['a'] }), {
      policy: 'union',
      resolver: rbac,
      identityMapping,
      audit
    })

    expect(resolve).toHaveBeenCalledWith(
      { user: 'issuer#alice', groups: ['system:authenticated', 'devs'] },
      { preferred: ['a'] }
    )
    expect(scope).toMatchObject({ scope: ['a', 'b'], source: 'union' })
    expect(audit.mock.calls[0][0]).toContain('user=issuer#alice namespaces=1')
  })

  it('reports an authorizer failure as inconclusive and keeps the claim under union', async () => {
    const { resolver: rbac } = resolver(new Error('Kubernetes API returned HTTP 503'))

    expect(
      await resolveCallerScope(context({ sub: 'alice', namespaces: ['a'] }), {
        policy: 'union',
        resolver: rbac,
        identityMapping
      })
    ).toMatchObject({
      scope: ['a'],
      source: 'rbac-inconclusive',
      detail: { rbacError: 'Kubernetes API returned HTTP 503' }
    })
  })

  it('reports a caller whose identity cannot be mapped as inconclusive', async () => {
    const { resolver: rbac, resolve } = resolver({ namespaces: ['a'] })

    expect(
      await resolveCallerScope(context({ sub: 'alice', identityClaims: {} }), {
        policy: 'rbac',
        resolver: rbac,
        identityMapping: { ...identityMapping, usernameClaim: 'email' }
      })
    ).toMatchObject({
      scope: [],
      source: 'rbac-inconclusive',
      detail: { rbacError: expect.stringContaining('KUBERNETES_USERNAME_CLAIM') }
    })
    expect(resolve).not.toHaveBeenCalled()
  })
})
