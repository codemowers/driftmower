import { expect, it, vi } from 'vitest'
import type { ClusterCapabilitiesDiscovery } from '../clients/cluster-capabilities.js'
import { WorkloadActions, type CallerRequest } from './workload-actions.js'

const identity = { user: 'issuer#alice', groups: ['oidc:developers', 'system:authenticated'] }
const target = { namespace: 'demo', name: 'app', uid: 'original-uid' }

function setup(
  options: { metadata?: object; spec?: object } = {},
  describeCrd?: ClusterCapabilitiesDiscovery['describeCrd']
) {
  const request = vi
    .fn<CallerRequest>()
    .mockResolvedValueOnce(
      JSON.stringify({
        metadata: { ...target, resourceVersion: '123', ...options.metadata },
        spec: options.spec ?? {}
      })
    )
    .mockResolvedValue('{}')

  return { service: new WorkloadActions(request, describeCrd), request }
}

it.each(['Deployment', 'StatefulSet', 'DaemonSet'] as const)(
  'requests a guarded %s template rollout as the caller',
  async kind => {
    const { service, request } = setup()
    const result = await service.restart({ ...target, kind, apiVersion: 'apps/v1' }, identity)
    const path = `/apis/apps/v1/namespaces/demo/${kind.toLowerCase()}s/app`

    expect(request.mock.calls[0]).toEqual([identity, path, 'GET'])
    expect(request.mock.calls[1]).toEqual([
      identity,
      path,
      'PATCH',
      {
        metadata: { uid: target.uid, resourceVersion: '123' },
        spec: {
          template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': result.requestedAt } } }
        }
      }
    ])
    expect(result.status).toBe('requested')
  }
)

it('uses CNPG Cluster metadata, not its pod template or pod deletion', async () => {
  const { service, request } = setup()
  const result = await service.restart(
    { ...target, kind: 'Cluster', apiVersion: 'postgresql.cnpg.io/v1' },
    identity
  )

  expect(request.mock.calls[1]).toEqual([
    identity,
    '/apis/postgresql.cnpg.io/v1/namespaces/demo/clusters/app',
    'PATCH',
    {
      metadata: {
        uid: target.uid,
        resourceVersion: '123',
        annotations: { 'kubectl.kubernetes.io/restartedAt': result.requestedAt }
      }
    }
  ])
})

it.each([
  [{ metadata: { uid: 'replacement' } }, 'identity changed'],
  [{ metadata: { ownerReferences: [{ kind: 'Cluster' }] } }, 'root workload'],
  [{ metadata: { deletionTimestamp: '2026-10-04T10:00:00Z' } }, 'terminating'],
  [{ spec: { paused: true } }, 'paused'],
  [{ spec: { updateStrategy: { type: 'OnDelete' } } }, 'OnDelete'],
  [{ spec: { updateStrategy: { rollingUpdate: { partition: 1 } } } }, 'Partitioned']
] as const)('rejects ineffective or stale rollouts without mutation: %s', async (options, error) => {
  const { service, request } = setup(options)

  await expect(
    service.restart({ ...target, kind: 'StatefulSet', apiVersion: 'apps/v1' }, identity)
  ).rejects.toThrow(error)
  expect(request).toHaveBeenCalledTimes(1)
})

it.each(['Job', 'CronJob', 'ReplicaSet', 'Dragonfly', 'Namespace'])(
  'does not invent a restart for %s',
  async kind => {
    const { service, request } = setup()

    await expect(
      service.restart({ ...target, kind, apiVersion: 'apps/v1' } as never, identity)
    ).rejects.toThrow('supported')
    expect(request).not.toHaveBeenCalled()
  }
)

it('terminates only the observed standalone pod with normal grace and UID/RV preconditions', async () => {
  const { service, request } = setup()

  await service.terminate(target, identity)
  expect(request.mock.calls[1]).toEqual([
    identity,
    '/api/v1/namespaces/demo/pods/app',
    'DELETE',
    {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: target.uid, resourceVersion: '123' }
    }
  ])
})

it.each([
  { ownerReferences: [{ kind: 'Job' }] },
  { ownerReferences: [{ kind: 'CronJob' }] },
  { ownerReferences: [{ kind: 'Deployment' }] },
  { annotations: { 'kubernetes.io/config.mirror': 'static' } },
  { uid: 'replacement' }
])('rejects owned, static or replacement pod termination: %s', async metadata => {
  const { service, request } = setup({ metadata })

  await expect(service.terminate(target, identity)).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1)
})

it('does not turn an API authorization error into success or retry', async () => {
  const { service, request } = setup()

  request.mockReset().mockRejectedValueOnce(new Error('Kubernetes API returned HTTP 403'))
  await expect(
    service.restart({ ...target, kind: 'Deployment', apiVersion: 'apps/v1' }, identity)
  ).rejects.toThrow('403')
  expect(request).toHaveBeenCalledTimes(1)
})

it('propagates concurrent-change rejection from PATCH without retry or claiming success', async () => {
  const { service, request } = setup()

  request.mockRejectedValueOnce(new Error('Kubernetes API returned HTTP 409'))
  await expect(
    service.restart({ ...target, kind: 'Deployment', apiVersion: 'apps/v1' }, identity)
  ).rejects.toThrow('409')
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1][2]).toBe('PATCH')
})

const annotationMap = { type: 'object', additionalProperties: { type: 'string' } }
const operatorSchemas = {
  Dragonfly: { properties: { spec: { properties: { annotations: annotationMap } } } },
  Redpanda: {
    properties: {
      spec: {
        properties: {
          clusterSpec: {
            properties: {
              statefulset: { properties: { podTemplate: { properties: { annotations: annotationMap } } } }
            }
          }
        }
      }
    }
  }
}

function discovery(
  kind: 'Dragonfly' | 'Redpanda',
  version: string,
  schema: Record<string, unknown> = operatorSchemas[kind]
) {
  const group = kind === 'Dragonfly' ? 'dragonflydb.io' : 'cluster.redpanda.com'
  const resource = kind === 'Dragonfly' ? 'dragonflies' : 'redpandas'

  return vi.fn<ClusterCapabilitiesDiscovery['describeCrd']>().mockResolvedValue({
    name: `${resource}.${group}`,
    group,
    resource,
    kind,
    scope: 'Namespaced',
    description: null,
    versions: [{ name: version, schema }]
  })
}

it.each([
  ['Dragonfly', 'dragonflydb.io/v1alpha1'],
  ['Redpanda', 'cluster.redpanda.com/v1alpha1'],
  ['Redpanda', 'cluster.redpanda.com/v1alpha2']
] as const)('restarts %s through its verified CR annotation map (%s)', async (kind, apiVersion) => {
  const describeCrd = discovery(kind, apiVersion.split('/')[1])
  const { service, request } = setup({}, describeCrd)
  const result = await service.restart({ ...target, kind, apiVersion }, identity)
  const annotations = { 'kubectl.kubernetes.io/restartedAt': result.requestedAt }
  const resource = kind === 'Dragonfly' ? 'dragonflies' : 'redpandas'

  expect(describeCrd).toHaveBeenCalledWith(`${resource}.${apiVersion.split('/')[0]}`)
  expect(request.mock.calls[1]).toEqual([
    identity,
    `/apis/${apiVersion}/namespaces/demo/${resource}/app`,
    'PATCH',
    {
      metadata: { uid: target.uid, resourceVersion: '123' },
      spec:
        kind === 'Dragonfly'
          ? { annotations }
          : {
              clusterSpec: { statefulset: { podTemplate: { annotations } } }
            }
    }
  ])
  expect(request).toHaveBeenCalledTimes(2)
})

it.each([{}, { properties: { spec: { properties: { annotations: { type: 'object' } } } } }])(
  'rejects an unsupported installed operator annotation map without patching',
  async schema => {
    const { service, request } = setup({}, discovery('Dragonfly', 'v1alpha1', schema))

    await expect(
      service.restart({ ...target, kind: 'Dragonfly', apiVersion: 'dragonflydb.io/v1alpha1' }, identity)
    ).rejects.toThrow('schema')
    expect(request).toHaveBeenCalledTimes(1)
  }
)

it('rejects unserved operator versions without patching', async () => {
  const { service, request } = setup({}, discovery('Redpanda', 'v1alpha1'))

  await expect(
    service.restart({ ...target, kind: 'Redpanda', apiVersion: 'cluster.redpanda.com/v1alpha2' }, identity)
  ).rejects.toThrow('schema')
  expect(request).toHaveBeenCalledTimes(1)
})

it.each([{ suspend: true }, { clusterSpec: { statefulset: { updateStrategy: { type: 'OnDelete' } } } }])(
  'rejects ineffective Redpanda restarts before patching',
  async spec => {
    const describeCrd = discovery('Redpanda', 'v1alpha2')
    const { service, request } = setup({ spec }, describeCrd)

    await expect(
      service.restart({ ...target, kind: 'Redpanda', apiVersion: 'cluster.redpanda.com/v1alpha2' }, identity)
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
    expect(describeCrd).not.toHaveBeenCalled()
  }
)

it('fails closed when operator schema discovery is unavailable', async () => {
  const { service, request } = setup()

  await expect(
    service.restart({ ...target, kind: 'Dragonfly', apiVersion: 'dragonflydb.io/v1alpha1' }, identity)
  ).rejects.toThrow('discovery')
  expect(request).toHaveBeenCalledTimes(1)
})
