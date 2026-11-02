import { setTimeout as sleep } from 'node:timers/promises'
import type { HttpStream } from './observability-http.js'

// Event-driven freshness for everything cached from the authorizer and the
// cluster shape. A RoleBinding or Role event flushes reviews for that
// namespace; a cluster-scoped RBAC change flushes everything; a namespace
// event refreshes the namespace listing; a CRD event refreshes discovery.
// With this running, the review-cache TTL is a safety net rather than the
// freshness mechanism.
//
// Each watch is one long-lived request. On a clean end it resumes from the
// last resourceVersion, which is exact. On 410 Gone (the version aged out) or
// any error it re-lists and, since events may have been missed, clears the
// cache it guards. Reconnects back off from one second to thirty.

export interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
  object?: { metadata?: { namespace?: string; name?: string; resourceVersion?: string }; code?: number }
}

export interface WatchTarget {
  // The collection path, e.g. /apis/rbac.authorization.k8s.io/v1/rolebindings.
  path: string
  // Called for ADDED/MODIFIED/DELETED. `namespace` is null for cluster-scoped objects.
  onEvent: (event: WatchEvent, namespace: string | null) => void
  // Called when events may have been missed: at (re)list after a gap.
  onResync: () => void
}

export interface RbacWatchOptions {
  targets: WatchTarget[]
  // Opens a streaming GET with service-account credentials.
  stream: (path: string) => Promise<HttpStream>
  // Reads the collection once for its resourceVersion.
  read: (path: string) => Promise<string>
  log: (message: string, metadata?: Record<string, unknown>) => void
  sleep?: (ms: number) => Promise<void>
  minBackoffMs?: number
  maxBackoffMs?: number
}

export interface RbacWatch {
  start(): void
  stop(): Promise<void>
}

export function createRbacWatch(options: RbacWatchOptions): RbacWatch {
  const wait = options.sleep ?? (ms => sleep(ms))
  const minBackoff = options.minBackoffMs ?? 1_000
  const maxBackoff = options.maxBackoffMs ?? 30_000
  let stopped = false
  let active: HttpStream[] = []
  const runners: Promise<void>[] = []
  let signalStop: () => void = () => undefined
  const stopping = new Promise<'stopped'>(resolve => {
    signalStop = () => resolve('stopped')
  })
  // Any await inside a runner races the stop signal, so stop() never waits on
  // a connect, a list or a backoff that would otherwise hold it hostage.
  const raced = async <T>(work: Promise<T>): Promise<T | 'stopped'> => Promise.race([work, stopping])

  async function run(target: WatchTarget): Promise<void> {
    let resourceVersion: string | null = null
    let backoff = minBackoff

    while (!stopped) {
      try {
        if (resourceVersion === null) {
          const body = await raced(options.read(`${target.path}?limit=1`))

          if (body === 'stopped') return

          const list = JSON.parse(body) as { metadata?: { resourceVersion?: string } }

          resourceVersion = list.metadata?.resourceVersion ?? '0'
          // A fresh list means events may have been missed since the last one.
          target.onResync()
        }

        const query = new URLSearchParams({ watch: '1', resourceVersion, allowWatchBookmarks: 'true' })
        const stream = await raced(options.stream(`${target.path}?${query}`))

        if (stream === 'stopped') return

        if (stream.status === 410) {
          stream.abort()
          resourceVersion = null
          continue
        }

        if (stream.status < 200 || stream.status >= 300) {
          stream.abort()
          throw new Error(`watch on ${target.path} returned HTTP ${stream.status}`)
        }

        active.push(stream)
        backoff = minBackoff

        for await (const line of stream.lines) {
          const event = JSON.parse(line) as WatchEvent

          if (event.type === 'ERROR') {
            // 410 arrives as an ERROR event on an established stream.
            if (event.object?.code === 410) resourceVersion = null
            else throw new Error(`watch on ${target.path} reported ${JSON.stringify(event.object ?? {})}`)

            break
          }

          if (event.object?.metadata?.resourceVersion) resourceVersion = event.object.metadata.resourceVersion

          if (event.type !== 'BOOKMARK') target.onEvent(event, event.object?.metadata?.namespace ?? null)
        }

        active = active.filter(candidate => candidate !== stream)
        // A clean end: resume from the last version, no resync needed.
      } catch (error) {
        if (stopped) return

        options.log('Kubernetes watch interrupted; reconnecting', {
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
          backoffMs: backoff
        })
        resourceVersion = null
        await raced(wait(backoff))
        backoff = Math.min(backoff * 2, maxBackoff)
      }
    }
  }

  return {
    start() {
      for (const target of options.targets) runners.push(run(target))
    },
    async stop() {
      stopped = true
      signalStop()

      for (const stream of active) stream.abort()

      await Promise.allSettled(runners)
    }
  }
}

// The standard set of things whose change can invalidate a cached authorizer
// answer or the cached cluster shape.
export function rbacWatchTargets(handlers: {
  invalidateNamespace: (namespace: string) => void
  clearReviews: () => void
  namespacesChanged: () => void
  discoveryChanged: () => void
}): WatchTarget[] {
  const namespaced = (path: string): WatchTarget => ({
    path,
    onEvent: (_event, namespace) =>
      namespace ? handlers.invalidateNamespace(namespace) : handlers.clearReviews(),
    onResync: handlers.clearReviews
  })
  const clusterWide = (path: string): WatchTarget => ({
    path,
    onEvent: handlers.clearReviews,
    onResync: handlers.clearReviews
  })

  return [
    namespaced('/apis/rbac.authorization.k8s.io/v1/roles'),
    namespaced('/apis/rbac.authorization.k8s.io/v1/rolebindings'),
    clusterWide('/apis/rbac.authorization.k8s.io/v1/clusterroles'),
    clusterWide('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
    {
      path: '/api/v1/namespaces',
      onEvent: event => {
        handlers.namespacesChanged()

        if (event.type === 'DELETED' && event.object?.metadata?.name)
          handlers.invalidateNamespace(event.object.metadata.name)
      },
      onResync: handlers.namespacesChanged
    },
    {
      path: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions',
      onEvent: handlers.discoveryChanged,
      onResync: handlers.discoveryChanged
    }
  ]
}
