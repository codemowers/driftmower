import { describe, expect, it, vi } from 'vitest'
import { createAccessChecker, describeAttributes } from './access-check.js'
import { KubernetesApiError } from './observability-kubernetes.js'

const identity = { user: 'issuer#alice', groups: ['system:authenticated'] }

describe('createAccessChecker', () => {
  it('turns review outcomes into yes, no and unknown with reasons', async () => {
    const allowed = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('Kubernetes access review was inconclusive'))
      .mockRejectedValueOnce(new KubernetesApiError(403))
    const checker = createAccessChecker(allowed)
    const create = { namespace: 'a', group: 'postgresql.cnpg.io', resource: 'clusters', verb: 'create' }

    expect(await checker.mayPerform(identity, create)).toEqual({ verdict: 'yes', reason: null })
    expect(await checker.mayPerform(identity, create)).toEqual({
      verdict: 'no',
      reason: 'Kubernetes RBAC denies create clusters.postgresql.cnpg.io in namespace a'
    })
    expect(await checker.mayPerform(identity, create)).toMatchObject({
      verdict: 'unknown',
      reason: expect.stringContaining('could not be evaluated')
    })
    expect(await checker.mayPerform(identity, create)).toMatchObject({
      verdict: 'unknown',
      reason: expect.stringContaining('service account may not create SubjectAccessReviews')
    })
  })

  it('bounds the excerpt of an authorizer error', async () => {
    const checker = createAccessChecker(vi.fn().mockRejectedValue(new Error('x'.repeat(500))))
    const { reason } = await checker.mayPerform(identity, { group: '', resource: 'pods', verb: 'list' })

    expect(reason!.length).toBeLessThan(260)
    expect(reason).toContain('…')
  })

  it('describes subresources, names and cluster scope', () => {
    expect(
      describeAttributes({
        group: '',
        resource: 'pods',
        subresource: 'log',
        verb: 'get',
        namespace: 'a',
        name: 'api'
      })
    ).toBe('get pods/log.core "api" in namespace a')
    expect(describeAttributes({ group: 'apps', resource: 'deployments', verb: 'create' })).toBe(
      'create deployments.apps cluster-wide'
    )
  })
})
