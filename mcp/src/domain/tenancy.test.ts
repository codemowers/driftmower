import { describe, expect, it } from 'vitest'
import { describeScope, mergeScopes, scopeFromClaim } from './tenancy.js'

const rbac = (
  namespaces: string[],
  extra: Partial<{ unknown: string[]; clusterWide: boolean; truncated: boolean }> = {}
) => ({
  namespaces,
  unknown: [],
  clusterWide: false,
  truncated: false,
  ...extra
})

describe('mergeScopes', () => {
  it('claim policy ignores the authorizer entirely', () => {
    expect(mergeScopes(['a'], rbac(['b']), 'claim')).toEqual(scopeFromClaim(['a']))
    expect(mergeScopes(undefined, rbac(['b']), 'claim')).toEqual({ scope: [], source: 'claim-missing' })
  })

  it('rbac policy uses only the authorizer and never the claim', () => {
    expect(mergeScopes(['a'], rbac(['b']), 'rbac', 'user X')).toMatchObject({ scope: ['b'], source: 'rbac' })
    expect(mergeScopes(['a'], rbac([]), 'rbac')).toMatchObject({ scope: [], source: 'rbac-empty' })
  })

  it('union takes both grants, and an absent claim contributes nothing', () => {
    expect(mergeScopes(['a'], rbac(['b', 'a']), 'union')).toMatchObject({
      scope: ['a', 'b'],
      source: 'union'
    })
    expect(mergeScopes(undefined, rbac(['b']), 'union')).toMatchObject({ scope: ['b'], source: 'rbac' })
    expect(mergeScopes([], rbac([]), 'union')).toMatchObject({ scope: [], source: 'rbac-empty' })
  })

  it('cluster-wide visibility lifts the restriction', () => {
    expect(mergeScopes(['a'], rbac([], { clusterWide: true }), 'union')).toMatchObject({
      scope: null,
      source: 'rbac'
    })
  })

  it('an unanswerable authorizer falls back to the claim under union and to nothing under rbac', () => {
    expect(mergeScopes(['a'], { error: 'webhook down' }, 'union', 'user X')).toEqual({
      scope: ['a'],
      source: 'rbac-inconclusive',
      detail: { identity: 'user X', claim: ['a'], rbacError: 'webhook down' }
    })
    expect(mergeScopes(['a'], { error: 'webhook down' }, 'rbac')).toMatchObject({
      scope: [],
      source: 'rbac-inconclusive'
    })
  })
})

describe('describeScope for authorizer-derived scopes', () => {
  it('explains an empty RBAC answer as a mapping question', () => {
    // Under the rbac policy a claim is informational only, so it can name
    // namespaces the authorizer still denies.
    const notice = describeScope(mergeScopes(['a'], rbac([]), 'rbac', 'Kubernetes user "issuer#alice"'), 0)

    expect(notice.scoped).toBe(true)
    expect(notice.note).toContain('issuer#alice')
    expect(notice.note).toContain('none of the namespaces your token claim names')
    expect(notice.note).toContain('KUBERNETES_USERNAME_CLAIM')
  })

  it('names the authorizer error and what the results fell back to', () => {
    expect(describeScope(mergeScopes(['a'], { error: 'webhook down' }, 'union', 'user X'), 1).note).toBe(
      'Kubernetes could not evaluate your access as user X: webhook down. Results are limited to the 1 namespace(s) your token claim names: a. This is an authorizer problem, not an empty cluster.'
    )
    expect(describeScope(mergeScopes(undefined, { error: 'webhook down' }, 'union'), 0).note).toContain(
      'No results can be returned.'
    )
  })

  it('appends inconclusive and truncation caveats to an ordinary scoped note', () => {
    const notice = describeScope(
      mergeScopes(undefined, rbac(['a'], { unknown: ['b'], truncated: true }), 'union'),
      2
    )

    expect(notice.note).toContain('Results are limited to the namespaces you may access: a.')
    expect(notice.note).toContain('1 further namespace(s) could not be evaluated')
    expect(notice.note).toContain('MCP_SCOPE_MAX_NAMESPACES')
  })

  it('treats cluster-wide visibility as unscoped', () => {
    expect(describeScope(mergeScopes(undefined, rbac([], { clusterWide: true }), 'union'), 5)).toEqual({
      scoped: false,
      namespaces: null,
      note: null
    })
  })
})
