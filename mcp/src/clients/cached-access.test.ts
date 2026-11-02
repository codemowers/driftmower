import { describe, expect, it, vi } from 'vitest'
import { cachedAllowed, identityKey } from './cached-access.js'

const alice = { user: 'issuer#alice', groups: ['system:authenticated', 'devs'] }
const bob = { user: 'issuer#bob', groups: ['system:authenticated'] }
const listPods = { namespace: 'a', group: '', resource: 'pods', verb: 'list' }

describe('cachedAllowed', () => {
  it('caches conclusive answers per identity and attribute tuple until the ttl passes', async () => {
    let clock = 0
    const review = vi.fn().mockResolvedValue(true)
    const { allowed } = cachedAllowed(review, { ttlMs: 100, now: () => clock })

    expect(await allowed(alice, listPods)).toBe(true)
    expect(await allowed(alice, listPods)).toBe(true)
    expect(review).toHaveBeenCalledTimes(1)
    await allowed(alice, { ...listPods, verb: 'create' })
    await allowed(alice, { ...listPods, namespace: 'b' })
    await allowed(alice, { ...listPods, subresource: 'log' })
    await allowed(bob, listPods)
    await allowed({ ...alice, groups: [...alice.groups].reverse() }, listPods) // same identity, reordered groups
    expect(review).toHaveBeenCalledTimes(5)
    clock = 101
    await allowed(alice, listPods)
    expect(review).toHaveBeenCalledTimes(6)
  })

  it('never caches an inconclusive review and shares an in-flight one', async () => {
    let resolveReview: (value: boolean) => void = () => undefined
    const review = vi
      .fn()
      .mockRejectedValueOnce(new Error('inconclusive'))
      .mockImplementationOnce(() => new Promise<boolean>(resolve => (resolveReview = resolve)))
    const { allowed } = cachedAllowed(review, { ttlMs: 100 })

    await expect(allowed(alice, listPods)).rejects.toThrow('inconclusive')
    const first = allowed(alice, listPods)
    const second = allowed(alice, listPods)

    resolveReview(false)
    expect(await Promise.all([first, second])).toEqual([false, false])
    expect(review).toHaveBeenCalledTimes(2)
  })

  it('invalidates by namespace or identity and reports what it removed', async () => {
    const review = vi.fn().mockResolvedValue(true)
    const { allowed, cache } = cachedAllowed(review, { ttlMs: 100 })

    await allowed(alice, listPods)
    await allowed(alice, { ...listPods, namespace: 'b' })
    await allowed(bob, listPods)
    await allowed(bob, { group: '', resource: 'pods', verb: 'list' }) // cluster-wide, namespace ''
    expect(cache.size()).toBe(4)
    expect(cache.invalidate({ namespace: 'a' })).toBe(2)
    expect(cache.invalidate({ identityKey: identityKey(bob) })).toBe(1)
    expect(cache.clear()).toBe(1)
    await allowed(alice, listPods)
    expect(review).toHaveBeenCalledTimes(5)
  })

  it('passes every review through when the ttl is zero', async () => {
    const review = vi.fn().mockResolvedValue(true)
    const { allowed, cache } = cachedAllowed(review, { ttlMs: 0 })

    await allowed(alice, listPods)
    await allowed(alice, listPods)
    expect(review).toHaveBeenCalledTimes(2)
    expect(cache.size()).toBe(0)
  })
})
