import { expect, it } from 'vitest'
import { defaultsFor, toMutationFacts } from './mutation-facts.js'

const cnpgTls = {
  metadata: { name: 'cnpg-tls' },
  description: 'Defaults serverTLSSecret.\n  Provision the Secret before starting the Cluster.',
  spec: {
    matchConstraints: {
      resourceRules: [{ apiGroups: ['postgresql.cnpg.io'], operations: ['CREATE', 'UPDATE'], resources: ['clusters'] }]
    }
  }
}
const target = {
  id: 'postgres' as const,
  resources: [
    { group: 'postgresql.cnpg.io', resource: 'clusters' },
    { group: '', resource: 'secrets' }
  ]
}

it('reports a bound mutation of an offering resource with its own description', () => {
  const facts = toMutationFacts([cnpgTls], [{ spec: { policyName: 'cnpg-tls' } }])

  expect(defaultsFor(facts, target)).toEqual([
    {
      policy: 'cnpg-tls',
      resource: 'clusters.postgresql.cnpg.io',
      description: 'Defaults serverTLSSecret. Provision the Secret before starting the Cluster.',
      namespaceScoped: false
    }
  ])
})

it('ignores unbound policies, other resources and update-only mutations', () => {
  const updateOnly = {
    ...cnpgTls,
    metadata: { name: 'update-only' },
    spec: {
      matchConstraints: {
        resourceRules: [{ apiGroups: ['postgresql.cnpg.io'], operations: ['UPDATE'], resources: ['clusters'] }]
      }
    }
  }
  const other = {
    ...cnpgTls,
    metadata: { name: 'dragonfly-tls' },
    spec: {
      matchConstraints: {
        resourceRules: [{ apiGroups: ['dragonflydb.io'], operations: ['CREATE'], resources: ['dragonflies'] }]
      }
    }
  }
  const facts = toMutationFacts(
    [cnpgTls, updateOnly, other],
    [{ spec: { policyName: 'update-only' } }, { spec: { policyName: 'dragonfly-tls' } }]
  )

  expect(defaultsFor(facts, target)).toEqual([])
})

it('marks a policy whose every binding selects namespaces as scoped', () => {
  const facts = toMutationFacts(
    [cnpgTls],
    [{ spec: { policyName: 'cnpg-tls', matchResources: { namespaceSelector: { matchLabels: { tier: 'x' } } } } }]
  )

  expect(defaultsFor(facts, target)[0].namespaceScoped).toBe(true)
})
