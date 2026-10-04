import { describe, expect, it, vi } from 'vitest'
import { fakeReader } from '../../../test/fake-kubernetes-reader.js'
import type { ClusterCatalog } from '../cluster-catalog.js'
import { loadAdmissionFacts, loadIngressSuffix } from './admission.js'

const guard = {
  name: 'sandbox-ingress-guard',
  description: null,
  kind: 'ValidatingAdmissionPolicy' as const,
  apiVersion: 'admissionregistration.k8s.io/v1',
  annotations: {},
  spec: {
    matchConstraints: {
      resourceRules: [{ apiGroups: ['networking.k8s.io'], operations: ['CREATE'], resources: ['ingresses'] }]
    },
    validations: [{ expression: 'true', message: 'Ingress hosts must be <id>.<domain>' }]
  },
  bindings: [
    {
      name: 'sandbox-ingress-guard-binding',
      description: null,
      kind: 'ValidatingAdmissionPolicyBinding' as const,
      apiVersion: 'admissionregistration.k8s.io/v1',
      spec: {
        policyName: 'sandbox-ingress-guard',
        validationActions: ['Deny'],
        paramRef: { name: 'sandbox-guard-params', namespace: 'kube-system' },
        matchResources: {
          namespaceSelector: { matchExpressions: [{ key: 'codemowers.io/sandbox', operator: 'Exists' }] }
        }
      }
    }
  ]
}

function catalog(policies: unknown[]): ClusterCatalog {
  return {
    listStorageClasses: vi.fn(),
    listAdmissionPolicies: vi.fn().mockResolvedValue({ policies, unavailableKinds: [] })
  } as unknown as ClusterCatalog
}

describe('admission facts from the catalog', () => {
  it('projects validating policies with their bindings, and bound mutating ones separately', async () => {
    const mutate = {
      ...guard,
      name: 'cnpg-tls',
      description: 'Defaults the server certificate Secret. Provision it before starting the Cluster.',
      kind: 'MutatingAdmissionPolicy',
      spec: {
        matchConstraints: {
          resourceRules: [{ apiGroups: ['postgresql.cnpg.io'], operations: ['CREATE', 'UPDATE'], resources: ['clusters'] }]
        }
      },
      bindings: [{ ...guard.bindings[0], kind: 'MutatingAdmissionPolicyBinding', spec: { policyName: 'cnpg-tls' } }]
    }
    const unbound = { ...mutate, name: 'unbound', bindings: [] }
    const facts = await loadAdmissionFacts(catalog([guard, mutate, unbound]))

    expect(facts).toMatchObject({
      known: true,
      value: {
        validating: [{ name: 'sandbox-ingress-guard', enforced: true, bindingLabelKeys: ['codemowers.io/sandbox'] }],
        mutating: [
          {
            name: 'cnpg-tls',
            description: 'Defaults the server certificate Secret. Provision it before starting the Cluster.',
            guards: [{ group: 'postgresql.cnpg.io', resource: 'clusters', operations: ['CREATE', 'UPDATE'] }],
            namespaceScoped: false
          }
        ]
      }
    })
  })

  it('reads the suffix from the ConfigMap the guard names, exactly where the binding says', async () => {
    const facts = await loadAdmissionFacts(catalog([guard]))
    const { read, calls } = fakeReader({
      '/api/v1/namespaces/kube-system/configmaps/sandbox-guard-params': {
        data: { ingressDomainSuffix: '.example.io' }
      }
    })

    expect(await loadIngressSuffix(read, facts.known ? facts.value.validating : [], 'configured.io')).toEqual({
      suffix: { value: 'example.io', source: 'guard-params' },
      degraded: []
    })
    expect(calls).toHaveLength(1)
  })

  it('falls back to the configured suffix, and reports a refused ConfigMap read', async () => {
    const facts = await loadAdmissionFacts(catalog([guard]))
    const refused = fakeReader({ '/api/v1/namespaces/kube-system/configmaps/sandbox-guard-params': 403 })

    expect(
      await loadIngressSuffix(refused.read, facts.known ? facts.value.validating : [], 'configured.io')
    ).toMatchObject({
      suffix: { value: 'configured.io', source: 'config' },
      degraded: [{ source: 'configmaps', status: 403 }]
    })
    // No guard at all: nothing is read, nothing is guessed.
    const untouched = fakeReader({})

    expect(await loadIngressSuffix(untouched.read, [], null)).toEqual({ suffix: null, degraded: [] })
    expect(untouched.calls).toHaveLength(0)
  })
})
