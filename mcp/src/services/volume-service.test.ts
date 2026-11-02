import { describe, expect, it, vi } from 'vitest'
import { VolumeService } from './volume-service.js'
import type { ObservabilityKubernetes } from '../clients/observability-kubernetes.js'

const caller = { identity: { user: 'alice', groups: ['team'] } }
const claim = {
  metadata: { namespace: 'team', name: 'data' },
  spec: {
    volumeName: 'pv-data',
    storageClassName: 'local',
    resources: { requests: { storage: '8Gi' } },
    accessModes: ['ReadWriteOnce']
  },
  status: { phase: 'Bound', capacity: { storage: '8Gi' } }
}
const volume = {
  metadata: { name: 'pv-data' },
  spec: {
    capacity: { storage: '8Gi' },
    claimRef: { namespace: 'team', name: 'data' },
    csi: {
      driver: 'topolvm.io',
      volumeAttributes: { private: 'not-exported' },
      controllerPublishSecretRef: { name: 'secret' }
    }
  },
  status: { phase: 'Bound' }
}

function setup() {
  const allowed = vi.fn<ObservabilityKubernetes['allowed']>(async () => true)
  const read = vi.fn(async (path: string) =>
    JSON.stringify(
      path.includes('persistentvolumeclaims')
        ? { items: [claim] }
        : path.includes('?')
          ? {
              items: [
                volume,
                {
                  metadata: { name: 'free' },
                  spec: { capacity: { storage: '2Gi' } },
                  status: { phase: 'Available' }
                }
              ]
            }
          : volume
    )
  )
  const request = vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: { namespace: 'team', persistentvolumeclaim: 'data' }, value: [1, '100'] }]
      }
    })
  }))
  const service = new VolumeService({
    kubernetes: { allowed, read },
    prometheusUrl: 'http://prometheus',
    request
  })

  return { service, allowed, read, request }
}

describe('volume inventory and usage', () => {
  it('reads PVC/PV bindings from Kubernetes and joins four fixed volume metrics by claim', async () => {
    const { service, allowed, read } = setup()
    const result = await service.listVolumes({ namespace: 'team' }, caller)

    expect(result.claims[0]).toMatchObject({
      boundVolume: 'pv-data',
      requestedStorage: '8Gi',
      provisionedStorage: '8Gi',
      usage: { usedBytes: 100, capacityBytes: 100, inodes: 100, inodesUsed: 100 }
    })
    expect(result.persistentVolumes[0]).toMatchObject({
      name: 'pv-data',
      capacityStorage: '8Gi',
      csiDriver: 'topolvm.io',
      claim: { namespace: 'team', name: 'data' }
    })
    expect(allowed).toHaveBeenCalledWith(caller.identity, {
      namespace: 'team',
      group: '',
      resource: 'persistentvolumeclaims',
      verb: 'list'
    })
    expect(allowed).toHaveBeenCalledWith(caller.identity, {
      group: '',
      resource: 'persistentvolumes',
      verb: 'get',
      name: 'pv-data'
    })
    expect(read).toHaveBeenCalledWith('/api/v1/persistentvolumes/pv-data')
    expect(result.metricSources).toHaveLength(4)
    expect(
      result.metricSources.every(
        source =>
          source.query.includes('max by (namespace,persistentvolumeclaim)') &&
          source.query.includes('namespace="team"')
      )
    ).toBe(true)
    expect(JSON.stringify(result)).not.toContain('not-exported')
    expect(JSON.stringify(result)).not.toContain('controllerPublishSecretRef')
  })
  it('keeps PVC inventory and binding names when the caller cannot read PV details', async () => {
    const { service, allowed, read } = setup()

    allowed.mockImplementation(
      async (identity, attributes) => Boolean(identity.user) && attributes.resource !== 'persistentvolumes'
    )
    const result = await service.listVolumes({ namespace: 'team' }, caller)

    expect(result.claims[0].boundVolume).toBe('pv-data')
    expect(result.persistentVolumes).toEqual([])
    expect(result.degraded[0].message).toContain('caller lacks get')
    expect(read.mock.calls.every(([path]) => path.includes('persistentvolumeclaims'))).toBe(true)
  })
  it.each([undefined, caller])(
    'refuses unauthorized PVC listings before any read or metric query (%j)',
    async identity => {
      const { service, allowed, read, request } = setup()

      allowed.mockResolvedValue(false)
      await expect(service.listVolumes({ namespace: 'team' }, identity)).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('requires global PV list permission before including unbound PVs', async () => {
    const { service, allowed, read } = setup()

    allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(service.listVolumes({ namespace: 'team', includeUnboundPVs: true }, caller)).rejects.toThrow(
      'cluster-wide list persistentvolumes'
    )
    expect(read).not.toHaveBeenCalled()
    allowed.mockResolvedValue(true)
    const result = await service.listVolumes({ includeUnboundPVs: true }, caller)

    expect(result.persistentVolumes.map(item => item.name)).toEqual(['free', 'pv-data'])
    expect(read).toHaveBeenCalledWith('/api/v1/persistentvolumeclaims?limit=200')
  })
  it('retains inventory with unavailable metrics, and discards foreign namespace samples', async () => {
    const { service, request } = setup()

    request.mockResolvedValue({ status: 503, body: 'unavailable' })
    let result = await service.listVolumes({ namespace: 'team' }, caller)

    expect(result.claims[0].usage.usedBytes).toBeNull()
    expect(result.degraded).toHaveLength(4)
    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { namespace: 'private', persistentvolumeclaim: 'secret-data' }, value: [1, '100'] }
          ]
        }
      })
    })
    result = await service.listVolumes({ namespace: 'team' }, caller)
    expect(result.claims[0].usage.usedBytes).toBeNull()
    expect(JSON.stringify(result)).not.toContain('secret-data')
    expect(result.degraded[0].message).toContain('outside the requested namespace')
  })
})
