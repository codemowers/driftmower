import { setTimeout } from 'node:timers'
import { describe, expect, it, vi } from 'vitest'
import type { AccessChecker } from './access-check.js'
import { createRbacScopeResolver, VISIBILITY_PROBE } from './rbac-scope.js'

const identity = { user: 'issuer#alice', groups: ['system:authenticated'] }

function checkerAnswering(answer: (namespace: string | undefined) => 'yes' | 'no' | 'unknown') {
  const mayPerform = vi.fn(async (_identity, attributes: { namespace?: string }) => ({
    verdict: answer(attributes.namespace),
    reason: null
  }))

  return { checker: { mayPerform } as unknown as AccessChecker, mayPerform }
}

describe('createRbacScopeResolver', () => {
  it('skips the sweep when the caller may list pods in every namespace', async () => {
    const { checker, mayPerform } = checkerAnswering(() => 'yes')
    const resolver = createRbacScopeResolver({ listNamespaces: async () => ['b', 'a'], checker })

    expect(await resolver.resolve(identity)).toEqual({
      namespaces: ['a', 'b'],
      unknown: [],
      clusterWide: true,
      total: 2,
      truncated: false,
      source: 'rbac'
    })
    expect(mayPerform).toHaveBeenCalledTimes(1)
    expect(mayPerform).toHaveBeenCalledWith(identity, VISIBILITY_PROBE)
  })

  it('probes each namespace, separating denied from inconclusive', async () => {
    const { checker, mayPerform } = checkerAnswering(namespace =>
      namespace === undefined ? 'no' : namespace === 'a' ? 'yes' : namespace === 'c' ? 'unknown' : 'no'
    )
    const resolver = createRbacScopeResolver({ listNamespaces: async () => ['c', 'b', 'a'], checker })

    expect(await resolver.resolve(identity)).toMatchObject({
      namespaces: ['a'],
      unknown: ['c'],
      clusterWide: false,
      total: 3,
      truncated: false
    })
    expect(mayPerform.mock.calls.slice(1).map(call => call[1])).toEqual([
      { ...VISIBILITY_PROBE, namespace: 'a' },
      { ...VISIBILITY_PROBE, namespace: 'b' },
      { ...VISIBILITY_PROBE, namespace: 'c' }
    ])
  })

  it('bounds the sweep, checks preferred namespaces first and reports truncation', async () => {
    const all = Array.from({ length: 30 }, (_, index) => `ns-${String(index).padStart(2, '0')}`)
    const { checker, mayPerform } = checkerAnswering(namespace => (namespace === undefined ? 'no' : 'yes'))
    const resolver = createRbacScopeResolver({
      listNamespaces: async () => all,
      checker,
      maxNamespaces: 5,
      concurrency: 2
    })

    const scope = await resolver.resolve(identity, { preferred: ['ns-29', 'ns-15'] })

    expect(scope).toMatchObject({ truncated: true, total: 30, clusterWide: false })
    expect(scope.namespaces).toEqual(['ns-00', 'ns-01', 'ns-02', 'ns-15', 'ns-29'])
    expect(mayPerform).toHaveBeenCalledTimes(6)
  })

  it('never runs more reviews at once than the concurrency bound', async () => {
    let inFlight = 0
    let peak = 0
    const mayPerform = vi.fn(async (_identity, attributes: { namespace?: string }) => {
      if (attributes.namespace === undefined) return { verdict: 'no' as const, reason: null }

      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight -= 1

      return { verdict: 'yes' as const, reason: null }
    })
    const resolver = createRbacScopeResolver({
      listNamespaces: async () => Array.from({ length: 20 }, (_, index) => `ns-${index}`),
      checker: { mayPerform } as unknown as AccessChecker,
      concurrency: 4
    })

    expect((await resolver.resolve(identity)).namespaces).toHaveLength(20)
    expect(peak).toBe(4)
  })
})
