import { describe, expect, it, vi } from 'vitest'
import { VERBS } from '../../domain/provisioning/access-facts.js'
import { fromResourceLists } from '../../domain/provisioning/api-surface.js'
import type { AccessChecker } from '../access-check.js'
import { createAccessMatrixBuilder } from './access-matrix.js'

const surface = fromResourceLists([
  {
    group: '',
    version: 'v1',
    list: {
      resources: [
        { name: 'pods', kind: 'Pod', namespaced: true },
        { name: 'pods/log', kind: 'Pod', namespaced: true },
        { name: 'nodes', kind: 'Node', namespaced: false }
      ]
    }
  },
  {
    group: 'apps',
    version: 'v1',
    list: { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true }] }
  },
  {
    group: 'apps',
    version: 'v1beta1',
    list: { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true }] }
  }
])
const identity = { user: 'issuer#alice', groups: ['system:authenticated'] }

describe('createAccessMatrixBuilder', () => {
  it('probes every namespaced resource type once per verb, no subresources, no cluster-scoped kinds', async () => {
    const mayPerform = vi.fn(async (_identity, attributes: { resource: string; verb: string }) => ({
      verdict:
        attributes.resource === 'pods' && attributes.verb === 'delete' ? ('no' as const) : ('yes' as const),
      reason: null
    }))
    const builder = createAccessMatrixBuilder({
      surface: async () => surface,
      checker: { mayPerform } as unknown as AccessChecker
    })

    expect(await builder.probeCount()).toBe(2 * VERBS.length)
    const matrix = await builder.build(identity, 'team-a')

    expect(Object.keys(matrix).sort()).toEqual(['/pods', 'apps/deployments'])
    expect(matrix['/pods'].delete).toBe('no')
    expect(matrix['/pods'].list).toBe('yes')
    expect(mayPerform).toHaveBeenCalledTimes(2 * VERBS.length)
    expect(mayPerform).toHaveBeenCalledWith(identity, {
      namespace: 'team-a',
      group: 'apps',
      resource: 'deployments',
      verb: 'create'
    })
  })

  it('records an inconclusive review as unknown, never as denied', async () => {
    const mayPerform = vi.fn(async () => ({ verdict: 'unknown' as const, reason: 'webhook down' }))
    const builder = createAccessMatrixBuilder({
      surface: async () => surface,
      checker: { mayPerform } as unknown as AccessChecker
    })

    expect((await builder.build(identity, 'x'))['apps/deployments'].create).toBe('unknown')
  })
})
