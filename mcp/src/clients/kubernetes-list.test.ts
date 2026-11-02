import { describe, expect, it, vi } from 'vitest'
import { collect } from './kubernetes-list.js'

describe('collect', () => {
  it('pages with continue tokens and projects every item', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ metadata: { continue: 'next/+' }, items: [{ n: 1 }] }))
      .mockResolvedValueOnce(JSON.stringify({ items: [{ n: 2 }] }))

    expect(await collect(read, '/api/v1/things', item => (item as { n: number }).n)).toEqual([1, 2])
    expect(read.mock.calls[0][0]).toBe('/api/v1/things?limit=500')
    expect(read.mock.calls[1][0]).toContain('continue=next%2F%2B')
  })

  it('appends to an existing query string', async () => {
    const read = vi.fn().mockResolvedValue(JSON.stringify({ items: [] }))

    await collect(read, '/api/v1/things?labelSelector=a', () => null, { limit: 10 })
    expect(read).toHaveBeenCalledWith('/api/v1/things?labelSelector=a&limit=10')
  })

  it('refuses an incomplete list rather than returning part of it', async () => {
    const read = vi.fn().mockResolvedValue(JSON.stringify({ metadata: { continue: 'more' }, items: [] }))

    await expect(collect(read, '/x', () => null, { maxPages: 2, what: 'Widget listing' })).rejects.toThrow(
      'Widget listing exceeds 2 pages'
    )
    expect(read).toHaveBeenCalledTimes(2)
  })
})
