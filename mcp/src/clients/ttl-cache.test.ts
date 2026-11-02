import { describe, expect, it, vi } from 'vitest'
import { createTtlCache, createTtlMemo } from './ttl-cache.js'

describe('createTtlCache', () => {
  it('expires entries by time and evicts the least recently used past the bound', () => {
    let clock = 0
    const cache = createTtlCache<number>({ ttlMs: 100, maxEntries: 2, now: () => clock })

    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1) // a is now most recent
    cache.set('c', 3) // evicts b
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe(3)
    clock = 101
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size()).toBe(1)
  })

  it('honours a per-entry ttl, filtered deletion and clear', () => {
    let clock = 0
    const cache = createTtlCache<{ ns: string }>({ ttlMs: 100, maxEntries: 10, now: () => clock })

    cache.set('short', { ns: 'a' }, 10)
    cache.set('long', { ns: 'b' })
    cache.set('other', { ns: 'a' })
    clock = 11
    expect(cache.get('short')).toBeUndefined()
    expect(cache.deleteWhere((_key, value) => value.ns === 'a')).toBe(1)
    expect(cache.clear()).toBe(1)
    expect(cache.size()).toBe(0)
  })
})

describe('createTtlMemo', () => {
  it('shares an in-flight load, reuses the value until expiry and forgets failures', async () => {
    let clock = 0
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('value')
    const memo = createTtlMemo(100, load, () => clock)

    await expect(memo.get()).rejects.toThrow('boom')
    expect(await Promise.all([memo.get(), memo.get()])).toEqual(['value', 'value'])
    expect(load).toHaveBeenCalledTimes(2)
    clock = 50
    expect(await memo.get()).toBe('value')
    expect(load).toHaveBeenCalledTimes(2)
    clock = 101
    await memo.get()
    expect(load).toHaveBeenCalledTimes(3)
    memo.invalidate()
    await memo.get()
    expect(load).toHaveBeenCalledTimes(4)
  })
})
