import { setImmediate, setTimeout } from 'node:timers'
import { describe, expect, it, vi } from 'vitest'
import type { HttpStream } from './observability-http.js'
import { createRbacWatch, rbacWatchTargets, type WatchTarget } from './rbac-watch.js'

// A scripted stream: yields the given lines, then ends (or throws).
function scripted(lines: string[], options: { status?: number; failAfter?: boolean } = {}): HttpStream {
  const abort = vi.fn()

  return {
    status: options.status ?? 200,
    abort,
    lines: (async function* () {
      for (const line of lines) yield line

      if (options.failAfter) throw new Error('connection reset')
    })()
  }
}

const rv = (version: string, extra: object = {}) =>
  JSON.stringify({ metadata: { resourceVersion: version, ...extra } })
const event = (type: string, object: object) => JSON.stringify({ type, object })

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve))
}

describe('createRbacWatch', () => {
  it('lists once for the version, resyncs, then forwards events and resumes from the last version on a clean end', async () => {
    const onEvent = vi.fn()
    const onResync = vi.fn()
    const streams = [
      scripted([
        event('ADDED', { metadata: { namespace: 'a', resourceVersion: '11' } }),
        event('BOOKMARK', { metadata: { resourceVersion: '12' } })
      ]),
      scripted([])
    ]
    let calls = 0
    const stream = vi.fn(async (path: string) => {
      void path

      return streams[calls++] ?? (await new Promise<HttpStream>(() => undefined))
    })
    const read = vi.fn(async () => rv('10'))
    const watch = createRbacWatch({
      targets: [{ path: '/apis/x/v1/things', onEvent, onResync }],
      stream,
      read,
      log: vi.fn(),
      sleep: async () => undefined
    })

    watch.start()
    await settle()
    expect(read).toHaveBeenCalledWith('/apis/x/v1/things?limit=1')
    expect(onResync).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'ADDED' }), 'a')
    expect(stream.mock.calls[0][0]).toBe(
      '/apis/x/v1/things?watch=1&resourceVersion=10&allowWatchBookmarks=true'
    )
    // Resumed from the bookmark, without re-listing.
    expect(stream.mock.calls[1][0]).toContain('resourceVersion=12')
    expect(read).toHaveBeenCalledTimes(1)
    await watch.stop()
  })

  it('re-lists and resyncs after 410 Gone and after a stream error, backing off', async () => {
    const onResync = vi.fn()
    const sleep = vi.fn(async () => undefined)
    const streams = [
      scripted([], { status: 410 }),
      scripted([event('ERROR', { code: 410 })]),
      scripted([event('MODIFIED', { metadata: { resourceVersion: '3' } })], { failAfter: true })
    ]
    let calls = 0
    const stream = vi.fn(async (path: string) => {
      void path

      return streams[calls++] ?? (await new Promise<HttpStream>(() => undefined))
    })
    const watch = createRbacWatch({
      targets: [{ path: '/p', onEvent: vi.fn(), onResync }],
      stream,
      read: vi.fn(async () => rv('1')),
      log: vi.fn(),
      sleep,
      minBackoffMs: 5,
      maxBackoffMs: 8
    })

    watch.start()
    await settle()
    // Initial list, then one re-list per 410 (two), then one after the error.
    expect(onResync).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledWith(5)
    await watch.stop()
  })

  it('stops cleanly, aborting live streams', async () => {
    const stream = scripted([])
    const never = new Promise<HttpStream>(() => undefined)
    let first = true
    const watch = createRbacWatch({
      targets: [{ path: '/p', onEvent: vi.fn(), onResync: vi.fn() }],
      stream: vi.fn(async () => (first ? ((first = false), stream) : never)),
      read: vi.fn(async () => rv('1')),
      log: vi.fn(),
      sleep: async () => undefined
    })

    watch.start()
    await settle()
    await expect(
      Promise.race([
        watch.stop(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 500))
      ])
    ).resolves.toBeUndefined()
  })
})

describe('rbacWatchTargets', () => {
  it('maps object kinds to the right invalidation', () => {
    const handlers = {
      invalidateNamespace: vi.fn(),
      clearReviews: vi.fn(),
      namespacesChanged: vi.fn(),
      discoveryChanged: vi.fn()
    }
    const targets = rbacWatchTargets(handlers)
    const byPath = Object.fromEntries(targets.map(target => [target.path, target])) as Record<
      string,
      WatchTarget
    >

    byPath['/apis/rbac.authorization.k8s.io/v1/rolebindings'].onEvent({ type: 'ADDED' }, 'team-a')
    expect(handlers.invalidateNamespace).toHaveBeenCalledWith('team-a')
    byPath['/apis/rbac.authorization.k8s.io/v1/clusterroles'].onEvent({ type: 'MODIFIED' }, null)
    expect(handlers.clearReviews).toHaveBeenCalledTimes(1)
    byPath['/api/v1/namespaces'].onEvent({ type: 'DELETED', object: { metadata: { name: 'gone' } } }, null)
    expect(handlers.namespacesChanged).toHaveBeenCalledTimes(1)
    expect(handlers.invalidateNamespace).toHaveBeenCalledWith('gone')
    byPath['/apis/apiextensions.k8s.io/v1/customresourcedefinitions'].onResync()
    expect(handlers.discoveryChanged).toHaveBeenCalledTimes(1)
    // A resync on a namespaced RBAC watch may have missed anything: clear all.
    byPath['/apis/rbac.authorization.k8s.io/v1/roles'].onResync()
    expect(handlers.clearReviews).toHaveBeenCalledTimes(2)
  })
})
