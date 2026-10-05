import { KubernetesApiError } from './observability-kubernetes.js'
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers'
import { randomUUID } from 'node:crypto'
import type { HttpStream } from './observability-http.js'
import type {
  KubernetesIdentity,
  KubernetesReader,
  ObservabilityKubernetes
} from './observability-kubernetes.js'
import type { RbacScopeResolver } from './rbac-scope.js'
import {
  inventory,
  objectSchema,
  projectSpec,
  sources,
  certificateSource,
  cnpgSource,
  workloadsInput,
  type Node,
  type Source,
  type WorkloadInventory,
  type WorkloadListing
} from './workloads.js'

const METADATA_ACCEPT = 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1'
const METADATA_LIST_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1'
const MAX_STREAMS = 32
const MAX_OBJECTS = 100_000
const MAX_NAMESPACES = 64
const IDLE_MS = 10 * 60_000

type Target = {
  source: Source
  path: string
  nodes: Map<string, Node>
  partitions: Map<string, Map<string, Node>>
  ready: Promise<void>
  version: string | null
  warning?: string
  stream?: HttpStream
  stopped: boolean
  runner?: Promise<void>
  cancel: () => void
  stopping: Promise<void>
}
type View = { targets: Set<string>; result: WorkloadInventory }
type NamespaceState = {
  views: Map<string, View>
  touched: number
  readers: number
}

export type WorkloadSnapshot = WorkloadInventory & { revision: string }
export interface WorkloadCache extends WorkloadListing {
  listWorkloads(input: { namespace?: string }, identity: KubernetesIdentity): Promise<WorkloadSnapshot>
  // Transport-independent invalidation, never caller-visible inventory. A
  // future WebSocket adapter must call listWorkloads with verified identity.
  subscribe(namespace: string, changed: (revision: string) => void): () => void
  stop(): Promise<void>
}

export function createWorkloadCache(options: {
  read: KubernetesReader
  watch: (path: string, accept?: string) => Promise<HttpStream>
  allowed: ObservabilityKubernetes['allowed']
  namespaceScope: RbacScopeResolver
}): WorkloadCache {
  const epoch = randomUUID()
  let revision = 0
  let stopped = false
  const namespaces = new Map<string, NamespaceState>()
  const targets = new Map<string, Target>()
  const listeners = new Map<string, Set<(revision: string) => void>>()
  const dirty = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let initialization: Promise<void> | undefined
  let objectCount = 0

  const group = (source: Source) => (source.apiVersion.includes('/') ? source.apiVersion.split('/')[0] : '')
  const base = (source: Source) =>
    group(source) ? `/apis/${source.apiVersion}` : `/api/${source.apiVersion}`
  const pathFor = (source: Source) => `${base(source)}/${source.resource}`
  const version = () => `${epoch}:${revision}`

  function build(namespace: string, view: View): void {
    const warnings = new Set<string>()
    const lists = new Map<Source, Node[]>()

    for (const path of view.targets) {
      const target = targets.get(path)

      if (!target) continue

      if (target.warning) warnings.add(`${namespace}: ${target.source.resource} ${target.warning}`)

      lists.set(target.source, [...(target.partitions.get(namespace)?.values() ?? [])])
    }

    view.result = {
      workloads: inventory(namespace, lists, warnings),
      ...(warnings.size ? { warnings: [...warnings].sort() } : {})
    }
  }

  function flush(): void {
    flushTimer = undefined
    for (const namespace of dirty) {
      const state = namespaces.get(namespace)

      if (!state) continue

      revision++
      for (const view of state.views.values()) build(namespace, view)
      for (const changed of listeners.get(namespace) ?? []) {
        // One subscriber must not break Kubernetes watches or other clients.
        try {
          changed(version())
        } catch {
          /* Adapter owns its errors. */
        }
      }
    }

    dirty.clear()
  }

  function changed(changedNamespace?: string): void {
    for (const namespace of namespaces.keys()) {
      if (changedNamespace && changedNamespace !== namespace) continue

      dirty.add(namespace)
    }

    if (!flushTimer && !stopped) {
      flushTimer = setTimeout(flush, 50)
      flushTimer.unref()
    }
  }

  function parseNode(raw: unknown, target: Target): Node {
    if (target.source.metadataOnly && (raw as { kind?: string })?.kind !== 'PartialObjectMetadata')
      throw new Error('Metadata-only response required')

    const parsed = objectSchema.parse(raw)

    if (target.source.namespaced !== false && !parsed.metadata.namespace)
      throw new Error('Namespace required on namespaced resource')

    if (target.source.namespaced === false && parsed.metadata.namespace)
      throw new Error('Unexpected namespace on cluster resource')

    // Only retain fields used by the graph. Secret/ConfigMap objects
    // negotiated metadata-only; their data/spec never enters this cache.
    return {
      metadata: parsed.metadata,
      ...(!target.source.metadataOnly ? { spec: projectSpec(target.source.kind, parsed.spec) } : {}),
      apiVersion: target.source.apiVersion,
      kind: target.source.kind
    }
  }

  async function list(target: Target): Promise<void> {
    const nodes = new Map<string, Node>()
    let continuation = ''
    let resourceVersion: string | undefined

    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error('Inventory page limit exceeded')

      const params = new URLSearchParams({ limit: '200' })

      if (continuation) params.set('continue', continuation)

      const body = JSON.parse(
        await options.read(
          `${target.path}?${params}`,
          target.source.metadataOnly ? METADATA_LIST_ACCEPT : undefined
        )
      ) as {
        kind?: string
        metadata?: { resourceVersion?: string; continue?: string }
        items?: unknown[]
      }

      if (target.stopped || stopped) return

      if (target.source.metadataOnly && body.kind !== 'PartialObjectMetadataList')
        throw new Error('Metadata-only list required')

      if (!Array.isArray(body.items) || !body.metadata?.resourceVersion)
        throw new Error('List resourceVersion required')

      if (resourceVersion && resourceVersion !== body.metadata.resourceVersion)
        throw new Error('List snapshot changed between pages')

      resourceVersion = body.metadata.resourceVersion
      for (const raw of body.items) {
        // Items in PartialObjectMetadataList may omit kind/apiVersion.
        const item = target.source.metadataOnly ? { ...(raw as object), kind: 'PartialObjectMetadata' } : raw
        const node = parseNode(item, target)

        nodes.set(node.metadata.uid, node)
      }

      if (objectCount - target.nodes.size + nodes.size > MAX_OBJECTS)
        throw new Error('Inventory object limit exceeded')

      continuation = body.metadata.continue ?? ''

      if (!continuation) break
    }

    objectCount += nodes.size - target.nodes.size
    target.nodes = nodes
    target.partitions = new Map()
    for (const node of nodes.values()) {
      let partition = target.partitions.get(node.metadata.namespace)

      if (!partition) {
        partition = new Map()
        target.partitions.set(node.metadata.namespace, partition)
      }

      partition.set(node.metadata.uid, node)
    }

    target.version = resourceVersion!
    target.warning = undefined
    changed()
  }

  async function run(target: Target, initialized: () => void): Promise<void> {
    let delay = 1000
    const race = async <T>(work: Promise<T>) => Promise.race([work, target.stopping.then(() => undefined)])

    while (!target.stopped && !stopped) {
      try {
        if (!target.version) await race(list(target))

        initialized()

        if (target.stopped || stopped) break

        const params = new URLSearchParams({
          watch: 'true',
          resourceVersion: target.version!,
          allowWatchBookmarks: 'true',
          timeoutSeconds: '300'
        })
        // Abort a connect which finishes after eviction/shutdown.
        const connecting = options
          .watch(`${target.path}?${params}`, target.source.metadataOnly ? METADATA_ACCEPT : undefined)
          .then(stream => {
            if (target.stopped || stopped) stream.abort()

            return stream
          })
        const stream = await race(connecting)

        if (!stream || target.stopped || stopped) break

        target.stream = stream

        if (stream.status < 200 || stream.status >= 300) throw new KubernetesApiError(stream.status)

        target.warning = undefined
        changed()
        delay = 1000
        for await (const line of stream.lines) {
          if (target.stopped || stopped) break

          if (line.length > 4 * 1024 * 1024) throw new Error('Watch event limit exceeded')

          const event = JSON.parse(line) as {
            type: string
            object: { kind?: string; code?: number; metadata?: { resourceVersion?: string } }
          }

          if (event.type === 'ERROR') throw new KubernetesApiError(event.object?.code ?? 500)

          if (event.type === 'BOOKMARK') {
            if (event.object?.metadata?.resourceVersion)
              target.version = event.object.metadata.resourceVersion

            continue
          }

          if (!['ADDED', 'MODIFIED', 'DELETED'].includes(event.type))
            throw new Error('Unexpected watch event')

          const node = parseNode(event.object, target)

          if (!node.metadata.resourceVersion) throw new Error('Watch resourceVersion required')

          target.version = node.metadata.resourceVersion
          const exists = target.nodes.has(node.metadata.uid)

          if (event.type === 'DELETED') {
            if (target.nodes.delete(node.metadata.uid)) objectCount--
          } else {
            if (!exists && objectCount >= MAX_OBJECTS) throw new Error('Inventory object limit exceeded')

            if (!exists) objectCount++

            target.nodes.set(node.metadata.uid, node)
          }

          let partition = target.partitions.get(node.metadata.namespace)

          if (!partition) {
            partition = new Map()
            target.partitions.set(node.metadata.namespace, partition)
          }

          if (event.type === 'DELETED') partition.delete(node.metadata.uid)
          else partition.set(node.metadata.uid, node)

          changed(node.metadata.namespace)
        }

        // Clean end resumes from the last event/bookmark without re-listing.
        // A short delay also bounds servers repeatedly closing empty watches.
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined

        await race(
          new Promise<void>(resolve => {
            reconnectTimer = setTimeout(resolve, 250)
            reconnectTimer.unref()
          })
        )
        clearTimeout(reconnectTimer)
      } catch (error) {
        if (target.stopped || stopped) break

        // Do not expose upstream bodies or publish a silently stale inventory.
        objectCount -= target.nodes.size
        target.nodes.clear()
        target.partitions.clear()
        target.version = null
        const reason =
          error instanceof KubernetesApiError
            ? `HTTP ${error.status}${error.status === 403 ? ' (service-account RBAC denied)' : error.status === 406 ? ' (metadata representation rejected)' : ''}`
            : error instanceof Error &&
                [
                  'Metadata-only response required',
                  'Metadata-only list required',
                  'List resourceVersion required',
                  'List snapshot changed between pages',
                  'Inventory page limit exceeded',
                  'Inventory object limit exceeded',
                  'Watch event limit exceeded',
                  'Watch resourceVersion required',
                  'Unexpected watch event',
                  'Namespace required on namespaced resource',
                  'Unexpected namespace on cluster resource'
                ].includes(error.message)
              ? error.message
              : 'connection or response validation failed'

        target.warning = `list/watch unavailable: ${reason}; inventory and orphan classification may be incomplete.`
        initialized()
        changed()
        let timer: ReturnType<typeof setTimeout> | undefined

        await race(
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, delay)
            timer.unref()
          })
        )
        clearTimeout(timer)
        delay = Math.min(delay * 2, 30_000)
      } finally {
        target.stream?.abort()
        target.stream = undefined
      }
    }

    initialized()
  }

  function ensure(source: Source): Target {
    const path = pathFor(source)
    let target = targets.get(path)

    if (!target) {
      if (targets.size >= MAX_STREAMS) throw new Error('Workload kind watch limit reached')

      let initialized = () => undefined as void
      let cancel = () => undefined as void
      const ready = new Promise<void>(resolve => {
        initialized = resolve
      })
      const stopping = new Promise<void>(resolve => {
        cancel = resolve
      })

      target = {
        source,
        path,
        nodes: new Map(),
        partitions: new Map(),
        ready,
        version: null,
        stopped: false,
        stopping,
        cancel
      }
      targets.set(path, target)
      target.runner = run(target, initialized)
    }

    return target
  }

  function initialize(): Promise<void> {
    if (initialization) return initialization

    initialization = (async () => {
      // One collection stream per kind for the entire cluster. Owner-reference
      // CR kinds are terminal labels; they never create additional watches.
      for (let offset = 0; offset < sources.length; offset += 4)
        await Promise.all(sources.slice(offset, offset + 4).map(source => ensure(source).ready))
      for (const source of [certificateSource, cnpgSource]) {
        try {
          const discovery = JSON.parse(await options.read(`/apis/${source.apiVersion}`)) as {
            resources?: { name: string; kind: string }[]
          }

          if (
            !stopped &&
            discovery.resources?.some(
              resource => resource.name === source.resource && resource.kind === source.kind
            )
          )
            await ensure(source).ready
        } catch {
          // Optional fixed dependency adapters; unavailable APIs create no
          // watch. Owner references never trigger arbitrary CRD discovery.
        }
      }
    })()

    return initialization
  }

  function evict(namespace: string): void {
    namespaces.delete(namespace)
    dirty.delete(namespace)
  }

  const evictionTimer = setInterval(() => {
    for (const [namespace, state] of namespaces)
      if (Date.now() - state.touched > IDLE_MS && !state.readers && !listeners.get(namespace)?.size)
        evict(namespace)
  }, 60_000)

  evictionTimer.unref()

  async function namespaceSnapshot(
    namespace: string,
    identity: KubernetesIdentity
  ): Promise<WorkloadInventory> {
    // A cached namespace graph is not authorization. Use the caller's list
    // permission for each source before constructing an authorized view.
    if (!(await options.allowed(identity, { namespace, group: '', resource: 'pods', verb: 'list' })))
      return { workloads: [], warnings: [`${namespace}: list pods is not authorized; inventory withheld.`] }

    let state = namespaces.get(namespace)

    if (!state) {
      if (namespaces.size >= MAX_NAMESPACES) {
        const victim = [...namespaces]
          .filter(([name, candidate]) => !candidate.readers && !listeners.get(name)?.size)
          .sort((a, b) => a[1].touched - b[1].touched)[0]

        if (!victim) throw new Error('Workload namespace cache limit reached')

        evict(victim[0])
      }

      state = {
        views: new Map(),
        touched: Date.now(),
        readers: 0
      }
      namespaces.set(namespace, state)
    }

    state.touched = Date.now()
    state.readers++
    try {
      await initialize()

      if (stopped || namespaces.get(namespace) !== state)
        throw new Error('Workload cache closed; retry the request')

      const permitted = new Set<string>()
      const denied: string[] = []
      const paths = [...targets.keys()].sort()

      for (let offset = 0; offset < paths.length; offset += 4)
        await Promise.all(
          paths.slice(offset, offset + 4).map(async path => {
            const source = targets.get(path)!.source
            const visible = await options.allowed(identity, {
              ...(source.namespaced === false ? {} : { namespace }),
              group: group(source),
              resource: source.resource,
              verb: 'list'
            })

            if (visible) permitted.add(path)
            else
              denied.push(
                `${namespace}: list ${source.resource} is not authorized; related inventory may be incomplete.`
              )
          })
        )

      if (stopped || namespaces.get(namespace) !== state)
        throw new Error('Workload cache closed; retry the request')

      // Flush pending events so polling clients don't observe the previous graph.
      if (dirty.size) {
        clearTimeout(flushTimer)
        flush()
      }

      const key = [...permitted].sort().join('\n')
      let view = state.views.get(key)

      if (!view) {
        // Permission combinations are bounded separately from cached namespaces.
        if (state.views.size >= 32) state.views.delete(state.views.keys().next().value!)

        view = { targets: permitted, result: { workloads: [] } }
        build(namespace, view)
        state.views.set(key, view)
      }

      return {
        workloads: view.result.workloads,
        ...(denied.length || view.result.warnings?.length
          ? { warnings: [...(view.result.warnings ?? []), ...denied].sort() }
          : {})
      }
    } finally {
      state.readers--
      state.touched = Date.now()
    }
  }

  return {
    async listWorkloads(raw, identity) {
      if (stopped) throw new Error('Workload cache is stopped')

      if (!identity.user) throw new Error('Workload inventory requires an authenticated caller')

      const input = workloadsInput.parse(raw)
      const scope = input.namespace ? undefined : await options.namespaceScope.resolve(identity)
      const candidates = input.namespace ? [input.namespace] : scope!.namespaces
      const workloads: WorkloadInventory['workloads'] = []
      const warnings: string[] = []

      if (scope?.unknown.length)
        warnings.push(
          `Access could not be evaluated for ${scope.unknown.length} namespaces; excluded from inventory.`
        )

      if (scope?.truncated)
        warnings.push('Namespace discovery truncated; specify a namespace for complete inventory.')

      for (const namespace of [...new Set(candidates)].sort()) {
        const result = await namespaceSnapshot(namespace, identity)

        workloads.push(...result.workloads)
        warnings.push(...(result.warnings ?? []))
      }

      return {
        workloads,
        revision: version(),
        ...(warnings.length ? { warnings: [...new Set(warnings)].sort() } : {})
      }
    },
    subscribe(namespace, changed) {
      if (stopped) throw new Error('Workload cache is stopped')

      let subscribers = listeners.get(namespace)

      if (!subscribers) {
        subscribers = new Set()
        listeners.set(namespace, subscribers)
      }

      subscribers.add(changed)

      return () => {
        subscribers.delete(changed)

        if (!subscribers.size) listeners.delete(namespace)
      }
    },
    async stop() {
      stopped = true
      clearInterval(evictionTimer)
      clearTimeout(flushTimer)
      const runners = [...targets.values()].map(target => target.runner)

      for (const namespace of namespaces.keys()) evict(namespace)
      listeners.clear()
      for (const target of targets.values()) {
        target.stopped = true
        target.cancel()
        target.stream?.abort()
        target.nodes.clear()
        target.partitions.clear()
      }

      targets.clear()
      objectCount = 0
      await Promise.allSettled(runners)
    }
  }
}
