import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkloadCache, type WorkloadCache } from './workload-cache.js'
import type { AccessAttributes, KubernetesIdentity } from './observability-kubernetes.js'

const identity = { user: 'alice', groups: ['dev'] }
const caches: WorkloadCache[] = []

afterEach(async () => {
  await Promise.all(caches.splice(0).map(cache => cache.stop()))
})
function object(name: string, kind = 'Pod', owners: object[] = [], spec = {}) {
  return {
    kind,
    metadata: { name, uid: name, namespace: 'team', resourceVersion: '2', ownerReferences: owners },
    spec
  }
}

function setup(objects: Record<string, object[]> = {}, cnpgAvailable = false) {
  const streams = new Map<string, { send: (event: object) => void; abort: () => void }>()
  const read = vi.fn(async (path: string, accept?: string) => {
    const url = new URL(path, 'https://kube')
    const resource = url.pathname.split('/').at(-1)!

    if (url.pathname === '/apis/postgresql.cnpg.io/v1')
      return JSON.stringify({ resources: cnpgAvailable ? [{ name: 'clusters', kind: 'Cluster' }] : [] })

    if (url.pathname === '/apis/cert-manager.io/v1')
      return JSON.stringify({
        resources: [{ name: 'certificates', kind: 'Certificate', namespaced: true, verbs: ['list', 'watch'] }]
      })

    if (accept && !accept.includes('as=PartialObjectMetadataList;'))
      throw new Error('List must negotiate list metadata')

    return JSON.stringify({
      kind: accept ? 'PartialObjectMetadataList' : 'List',
      metadata: { resourceVersion: '1' },
      items: objects[resource] ?? []
    })
  })
  const watch = vi.fn(async (path: string, accept?: string) => {
    const url = new URL(path, 'https://kube')
    const resource = url.pathname.split('/').at(-1)!
    const queue: string[] = []
    let signal: (() => void) | undefined
    let ended = false
    const abort = () => {
      ended = true
      signal?.()
    }

    const send = (event: object) => {
      queue.push(JSON.stringify(event))
      signal?.()
    }

    streams.set(resource, { send, abort })

    return {
      status: 200,
      abort,
      lines: (async function* () {
        while (!ended) {
          if (!queue.length)
            await new Promise<void>(resolve => {
              signal = resolve
            })

          while (queue.length && !ended) yield queue.shift()!
        }
      })(),
      metadataOnly: Boolean(accept)
    }
  })
  const allowed = vi.fn<(identity: KubernetesIdentity, attributes: AccessAttributes) => Promise<boolean>>(
    async () => true
  )
  const namespaceScope = {
    resolve: vi.fn(async () => ({
      namespaces: ['team'],
      unknown: [],
      clusterWide: false,
      total: 1,
      truncated: false,
      source: 'rbac' as const
    }))
  }
  const cache = createWorkloadCache({ read, watch, allowed, namespaceScope })

  caches.push(cache)

  return { cache, read, watch, allowed, streams }
}

describe('watch-backed workload snapshots', () => {
  it('shares cluster-wide lists and treats custom owners as terminal references without watching them', async () => {
    const ref = {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      name: 'database',
      uid: 'database',
      controller: true
    }
    const { cache, read, watch } = setup({
      pods: [object('db-0', 'Pod', [ref])],
      clusters: [object('database', 'Cluster')],
      secrets: [object('unused-secret', 'Secret')]
    })
    const first = await cache.listWorkloads({}, identity)
    const reads = read.mock.calls.length
    const second = await cache.listWorkloads({ namespace: 'team' }, identity)

    expect(second.workloads).toEqual(first.workloads)
    expect(read).toHaveBeenCalledTimes(reads)
    expect(first.workloads.find(item => item.kind === 'Cluster')).toMatchObject({
      name: 'database',
      pods: ['db-0']
    })
    expect(first.workloads.find(item => item.kind === 'Cluster')?.ownerReferenceOnly).toBe(true)
    expect(watch.mock.calls.some(([path]) => path.includes('/clusters?'))).toBe(false)
    expect(read.mock.calls.every(([path]) => !path.includes('/namespaces/'))).toBe(true)
    expect(watch.mock.calls.every(([path]) => !path.includes('/namespaces/'))).toBe(true)
    expect(watch.mock.calls.find(([path]) => path.includes('/secrets?'))?.[1]).toContain(
      'PartialObjectMetadata'
    )
  })
  it('applies add/delete events and emits revision invalidations without relisting', async () => {
    const { cache, read, streams } = setup()
    const first = await cache.listWorkloads({ namespace: 'team' }, identity)
    const reads = read.mock.calls.length
    const changed = vi.fn()
    const unsubscribe = cache.subscribe('team', changed)

    streams.get('pods')!.send({ type: 'ADDED', object: object('one') })
    await vi.waitFor(async () => {
      const result = await cache.listWorkloads({ namespace: 'team' }, identity)

      expect(result.workloads.flatMap(item => item.pods ?? [])).toContain('one')
      expect(result.revision).not.toBe(first.revision)
    })
    streams.get('pods')!.send({ type: 'DELETED', object: object('one') })
    await vi.waitFor(async () => {
      expect(
        (await cache.listWorkloads({ namespace: 'team' }, identity)).workloads.flatMap(
          item => item.pods ?? []
        )
      ).not.toContain('one')
    })
    expect(read).toHaveBeenCalledTimes(reads)
    expect(changed).toHaveBeenCalled()
    unsubscribe()
  })
  it('rechecks each caller permission and withholds denied cached collections', async () => {
    const { cache, allowed, read } = setup({ secrets: [object('private', 'Secret')] })

    expect(JSON.stringify(await cache.listWorkloads({}, identity))).toContain('private')
    const reads = read.mock.calls.length

    allowed.mockImplementation(async (_identity, attributes) => attributes.resource !== 'secrets')
    const result = await cache.listWorkloads({}, identity)

    expect(JSON.stringify(result.workloads)).not.toContain('private')
    expect(result.warnings?.some(warning => warning.includes('list secrets'))).toBe(true)
    expect(read).toHaveBeenCalledTimes(reads)
    allowed.mockResolvedValue(false)
    expect((await cache.listWorkloads({ namespace: 'team' }, identity)).workloads).toEqual([])
  })
  it('rejects anonymous callers and does not read denied namespaces', async () => {
    const { cache, read, allowed } = setup()

    await expect(cache.listWorkloads({}, { user: '', groups: [] })).rejects.toThrow('authenticated')
    allowed.mockResolvedValue(false)
    await cache.listWorkloads({ namespace: 'team' }, identity)
    expect(read).not.toHaveBeenCalled()
  })
})

it('watches discovered CNPG Clusters once, updates API-read dependencies, and filters by caller permission', async () => {
  const ref = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    name: 'database',
    uid: 'database',
    controller: true
  }
  const clusterSpec = (secretName: string) => ({
    certificates: { serverTLSSecret: secretName },
    monitoring: { customQueriesConfigMap: [{ name: 'cnpg-default-monitoring' }] }
  })
  const { cache, read, watch, streams, allowed } = setup(
    {
      pods: [object('database-1', 'Pod', [ref])],
      clusters: [object('database', 'Cluster', [], clusterSpec('tls'))],
      certificates: [object('certificate', 'Certificate', [], { secretName: 'tls' })],
      secrets: [object('tls', 'Secret')],
      configmaps: [object('cnpg-default-monitoring', 'ConfigMap')]
    },
    true
  )
  const first = await cache.listWorkloads({ namespace: 'team' }, identity)
  const reads = read.mock.calls.length

  expect(first.workloads.find(item => item.kind === 'Cluster')).toMatchObject({
    secrets: ['tls'],
    configmaps: ['cnpg-default-monitoring'],
    certificates: ['certificate']
  })
  expect(first.workloads.find(item => item.kind === 'Cluster')?.ownerReferenceOnly).toBeUndefined()
  expect(watch.mock.calls.filter(([path]) => path.includes('/clusters?'))).toHaveLength(1)

  streams
    .get('clusters')!
    .send({ type: 'MODIFIED', object: object('database', 'Cluster', [], clusterSpec('replacement-tls')) })
  await vi.waitFor(async () => {
    const result = await cache.listWorkloads({ namespace: 'team' }, identity)

    expect(result.workloads.find(item => item.kind === 'Cluster')?.secrets).toEqual(['replacement-tls'])
  })
  expect(read).toHaveBeenCalledTimes(reads)

  allowed.mockImplementation(async (_identity, attributes) => attributes.resource !== 'clusters')
  const denied = await cache.listWorkloads({ namespace: 'team' }, identity)

  expect(denied.workloads.find(item => item.kind === 'Cluster')?.ownerReferenceOnly).toBe(true)
  expect(denied.workloads.find(item => item.kind === 'Cluster')?.secrets).toBeUndefined()
})
