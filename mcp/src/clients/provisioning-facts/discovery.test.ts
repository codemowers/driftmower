import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fakeReader } from '../../../test/fake-kubernetes-reader.js'
import { AGGREGATED_ACCEPT, loadApiSurface } from './discovery.js'

const aggregated = JSON.parse(
  readFileSync(
    new URL('../../../test/fixtures/kubernetes/aggregated-discovery.json', import.meta.url),
    'utf8'
  )
) as unknown

const aggregatedCore = {
  kind: 'APIGroupDiscoveryList',
  items: [
    {
      metadata: { name: '' },
      versions: [
        {
          version: 'v1',
          resources: [
            { resource: 'pods', responseKind: { kind: 'Pod' }, scope: 'Namespaced' },
            { resource: 'nodes', responseKind: { kind: 'Node' }, scope: 'Cluster' }
          ]
        }
      ]
    }
  ]
}

describe('loadApiSurface', () => {
  it('reads aggregated discovery for the core and the named groups and merges them', async () => {
    const { read, calls } = fakeReader({ '/apis': aggregated, '/api': aggregatedCore })
    const surface = await loadApiSurface(read)

    expect(calls.map(call => call.path).sort()).toEqual(['/api', '/apis'])
    expect(calls.every(call => call.accept === AGGREGATED_ACCEPT)).toBe(true)
    expect(surface.aggregated).toBe(true)
    expect(surface.byKind.get('apps/v1/Deployment')?.plural).toBe('deployments')
    // The regression this guards: /apis alone carries no core resources.
    expect(surface.byKind.get('v1/Pod')).toEqual({
      group: '',
      version: 'v1',
      kind: 'Pod',
      plural: 'pods',
      namespaced: true
    })
    expect(surface.versionsByGroup.get('')).toEqual(['v1'])
  })

  it('falls back to one read per group version on an older apiserver, tolerating a vanished group', async () => {
    const { read, calls } = fakeReader({
      '/api': { kind: 'APIVersions', versions: ['v1'] },
      '/api/v1': {
        resources: [
          { name: 'pods', kind: 'Pod', namespaced: true },
          { name: 'pods/log', kind: 'Pod', namespaced: true }
        ]
      },
      '/apis': {
        groups: [
          { name: 'apps.emqx.io', versions: [{ version: 'v2beta1' }] },
          { name: 'gone.io', versions: [{ version: 'v1' }] }
        ]
      },
      '/apis/apps.emqx.io/v2beta1': { resources: [{ name: 'emqxes', kind: 'EMQX', namespaced: true }] },
      '/apis/gone.io/v1': 404
    })
    const surface = await loadApiSurface(read)

    expect(calls.map(call => call.path).sort()).toEqual([
      '/api',
      '/api/v1',
      '/apis',
      '/apis/apps.emqx.io/v2beta1',
      '/apis/gone.io/v1'
    ])
    expect(surface.aggregated).toBe(false)
    expect(surface.byKind.get('v1/Pod')?.plural).toBe('pods')
    expect(surface.byKind.get('apps.emqx.io/v2beta1/EMQX')?.plural).toBe('emqxes')
    expect(surface.versionsByGroup.get('gone.io')).toEqual(['v1'])
  })
})
