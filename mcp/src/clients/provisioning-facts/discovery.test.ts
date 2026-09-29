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

describe('loadApiSurface', () => {
  it('asks for aggregated discovery and parses it in one request', async () => {
    const { read, calls } = fakeReader({ '/apis': aggregated })
    const surface = await loadApiSurface(read)

    expect(calls).toEqual([{ path: '/apis', accept: AGGREGATED_ACCEPT }])
    expect(surface.aggregated).toBe(true)
    expect(surface.byKind.get('apps/v1/Deployment')?.plural).toBe('deployments')
  })

  it('falls back to one read per group version on an older apiserver, tolerating a vanished group', async () => {
    const { read, calls } = fakeReader({
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

    expect(calls.map(call => call.path)).toEqual(['/apis', '/apis/apps.emqx.io/v2beta1', '/apis/gone.io/v1'])
    expect(surface.aggregated).toBe(false)
    expect(surface.byKind.get('apps.emqx.io/v2beta1/EMQX')?.plural).toBe('emqxes')
    expect(surface.versionsByGroup.get('gone.io')).toEqual(['v1'])
  })
})
