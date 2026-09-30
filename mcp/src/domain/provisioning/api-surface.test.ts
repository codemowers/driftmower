import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  fromAggregated,
  fromResourceLists,
  groupVersionsOf,
  isAggregated,
  mergeSurfaces,
  negotiateVersion,
  servesGroup,
  type AggregatedList,
  type GroupList
} from './api-surface.js'

// Captured from a real apiserver (minikube v1.35.1) and trimmed to the fields
// the parser reads, so a shape change upstream fails here rather than in prod.
const aggregated = JSON.parse(
  readFileSync(
    new URL('../../../test/fixtures/kubernetes/aggregated-discovery.json', import.meta.url),
    'utf8'
  )
) as AggregatedList

it('detects the aggregated shape and rejects the legacy one', () => {
  expect(isAggregated(aggregated)).toBe(true)
  expect(isAggregated({ groups: [{ name: 'apps', versions: [{ version: 'v1' }] }] })).toBe(false)
})

it('parses kinds, plurals and scope out of aggregated discovery', () => {
  const surface = fromAggregated(aggregated)

  expect(surface.byKind.get('apps/v1/Deployment')).toEqual({
    group: 'apps',
    version: 'v1',
    kind: 'Deployment',
    plural: 'deployments',
    namespaced: true
  })
  expect(surface.byKind.get('monitoring.coreos.com/v1/PodMonitor')).toEqual({
    group: 'monitoring.coreos.com',
    version: 'v1',
    kind: 'PodMonitor',
    plural: 'podmonitors',
    namespaced: true
  })
  expect(surface.aggregated).toBe(true)
  expect(servesGroup(surface, 'monitoring.coreos.com')).toBe(true)
  expect(servesGroup(surface, 'postgresql.cnpg.io')).toBe(false)
})

it('legacy parsing drops subresources, which are not creatable', () => {
  const surface = fromResourceLists([
    {
      group: 'monitoring.coreos.com',
      version: 'v1',
      list: {
        resources: [
          { name: 'podmonitors', kind: 'PodMonitor', namespaced: true },
          { name: 'podmonitors/status', kind: 'PodMonitor', namespaced: true }
        ]
      }
    }
  ])

  expect(surface.byKind.size).toBe(1)
  expect(surface.byKind.get('monitoring.coreos.com/v1/PodMonitor')?.plural).toBe('podmonitors')
  expect(surface.aggregated).toBe(false)
})

it('legacy parsing tolerates a group that vanished between calls', () => {
  const surface = fromResourceLists([{ group: 'gone.example.com', version: 'v1', list: null }])

  expect(surface.byKind.size).toBe(0)
  // The version is still recorded: the group exists, we just could not list it.
  expect(surface.versionsByGroup.get('gone.example.com')).toEqual(['v1'])
})

it('groupVersionsOf flattens every served version, not just the preferred one', () => {
  const groups: GroupList = {
    groups: [{ name: 'apps.emqx.io', versions: [{ version: 'v2beta1' }, { version: 'v2alpha1' }] }]
  }

  expect(groupVersionsOf(groups)).toEqual([
    { group: 'apps.emqx.io', version: 'v2beta1' },
    { group: 'apps.emqx.io', version: 'v2alpha1' }
  ])
})

it("version negotiation prefers the recipe's order over the cluster's", () => {
  const surface = fromResourceLists([
    {
      group: 'apps.emqx.io',
      version: 'v2alpha1',
      list: { resources: [{ name: 'emqxes', kind: 'EMQX', namespaced: true }] }
    },
    {
      group: 'apps.emqx.io',
      version: 'v2beta1',
      list: { resources: [{ name: 'emqxes', kind: 'EMQX', namespaced: true }] }
    }
  ])

  // The recipe wants v2beta1 first, and the cluster serves both.
  expect(negotiateVersion(surface, 'apps.emqx.io', 'EMQX', ['v2beta1', 'v2alpha1'])?.version).toBe('v2beta1')
  // Only the fallback is supported by the recipe.
  expect(negotiateVersion(surface, 'apps.emqx.io', 'EMQX', ['v2alpha1'])?.version).toBe('v2alpha1')
})

it('version negotiation returns null when the cluster serves only unknown versions', () => {
  const surface = fromResourceLists([
    {
      group: 'apps.emqx.io',
      version: 'v2alpha2',
      list: { resources: [{ name: 'emqxes', kind: 'EMQX', namespaced: true }] }
    }
  ])

  // This is the fail-safe: the planner must block, not emit a rejected manifest.
  expect(negotiateVersion(surface, 'apps.emqx.io', 'EMQX', ['v2beta1', 'v2alpha1'])).toBe(null)
})

it('merging keeps every kind and unions versions, and is aggregated only if all parts were', () => {
  const core = fromResourceLists([
    { group: '', version: 'v1', list: { resources: [{ name: 'pods', kind: 'Pod', namespaced: true }] } }
  ])
  const named = fromAggregated(aggregated)
  const merged = mergeSurfaces(core, named)

  expect(merged.byKind.get('v1/Pod')?.plural).toBe('pods')
  expect(merged.byKind.get('apps/v1/Deployment')?.plural).toBe('deployments')
  expect(merged.aggregated).toBe(false)
  expect(mergeSurfaces(named, named).versionsByGroup.get('apps')).toEqual(named.versionsByGroup.get('apps'))
})
