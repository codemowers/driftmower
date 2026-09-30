import { describe, expect, it, vi } from 'vitest'
import { VERBS } from '../../domain/provisioning/access-facts.js'
import { toAdmissionFacts } from '../../domain/provisioning/admission-facts.js'
import { fakeReader, list } from '../../../test/fake-kubernetes-reader.js'
import type { AccessMatrixBuilder } from './access-matrix.js'
import { loadNamespaceFacts } from './namespace.js'

const identity = { user: 'issuer#alice', groups: ['system:authenticated'] }
const row = (create: 'yes' | 'no' | 'unknown') =>
  Object.fromEntries(VERBS.map(verb => [verb, verb === 'create' ? create : 'yes']))
const matrix = {
  '/pods': row('yes'),
  '/secrets': row('yes'),
  'postgresql.cnpg.io/clusters': row('yes'),
  'networking.k8s.io/networkpolicies': row('yes')
}
const builder = (result = matrix): AccessMatrixBuilder => ({
  build: vi.fn().mockResolvedValue(result),
  probeCount: vi.fn()
})
const target = {
  id: 'postgres' as const,
  resources: [
    { group: 'postgresql.cnpg.io', resource: 'clusters' },
    { group: '', resource: 'secrets' }
  ]
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    '/api/v1/namespaces/team-a/resourcequotas': list([
      { metadata: { name: 'q' }, status: { hard: { pods: '10' }, used: { pods: '4' } } }
    ]),
    '/api/v1/namespaces/team-a/limitranges': list([]),
    '/apis/networking.k8s.io/v1/namespaces/team-a/networkpolicies': list([
      { metadata: { name: 'deny' }, spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] } }
    ]),
    '/apis/cilium.io/v2/namespaces/team-a/ciliumnetworkpolicies': 404,
    '/api/v1/namespaces/team-a': {
      metadata: {
        labels: { 'codemowers.io/sandbox': 'abc-team', 'pod-security.kubernetes.io/enforce': 'restricted' }
      }
    },
    ...extra
  }
}

describe('loadNamespaceFacts', () => {
  it('assembles budget, posture, tenant, pod security and the access profile', async () => {
    const { read } = fakeReader(routes())
    const { fact, labels, degraded } = await loadNamespaceFacts(
      { read, matrix: builder() },
      {
        namespace: 'team-a',
        identity,
        offeringLabelKey: 'cnpg.io/cluster',
        target,
        targets: [target],
        tenantLabelKey: 'codemowers.io/sandbox',
        admissionFacts: []
      }
    )

    expect(fact.headroom?.pods).toBe(6)
    expect(fact.network).toMatchObject({ ingress: 'default-deny', egress: 'open', ciliumAvailable: false })
    expect(fact.tenant).toEqual({ labelKey: 'codemowers.io/sandbox', id: 'abc-team' })
    expect(fact.sandbox).toBe('abc-team')
    expect(fact.podSecurity?.enforce).toBe('restricted')
    expect(fact.access?.view).toBe('yes')
    expect(fact.access?.provision.postgres).toBe('yes')
    expect(fact.mayCreate).toBe('yes')
    expect(labels['codemowers.io/sandbox']).toBe('abc-team')
    expect(degraded).toEqual([])
  })

  it('lets an enforced admission denial outrank an RBAC yes, using the caller groups', async () => {
    const facts = toAdmissionFacts(
      [
        {
          metadata: { name: 'guard' },
          spec: {
            matchConstraints: {
              resourceRules: [
                { apiGroups: ['postgresql.cnpg.io'], operations: ['CREATE'], resources: ['clusters'] }
              ]
            },
            variables: [{ name: 'x', expression: "'admins' in request.userInfo.groups" }],
            validations: [{ message: 'no databases here' }]
          }
        }
      ],
      [{ spec: { policyName: 'guard', validationActions: ['Deny'] } }]
    )
    const input = {
      namespace: 'team-a',
      offeringLabelKey: null,
      target,
      targets: [target],
      tenantLabelKey: null,
      admissionFacts: facts
    }

    const blocked = await loadNamespaceFacts(
      { read: fakeReader(routes()).read, matrix: builder() },
      { ...input, identity }
    )

    expect(blocked.fact.mayCreate).toBe('no')
    expect(blocked.fact.mayCreateReason).toContain('guard')
    // Every offering gets the composed verdict, not just the one asked about.
    expect(blocked.fact.offerings.postgres).toMatchObject({
      verdict: 'no',
      reason: expect.stringContaining('guard')
    })
    // RBAC alone says yes; the composed verdict is what callers should show.
    expect(blocked.fact.access?.provision.postgres).toBe('yes')
    const admin = await loadNamespaceFacts(
      { read: fakeReader(routes()).read, matrix: builder() },
      { ...input, identity: { ...identity, groups: ['admins'] } }
    )

    expect(admin.fact.mayCreate).toBe('yes')
    expect(admin.fact.offerings.postgres?.verdict).toBe('yes')
  })

  it('is honest without a caller, and reports refused reads and unknown reviews as degraded', async () => {
    const { read } = fakeReader(routes({ '/api/v1/namespaces/team-a/resourcequotas': 403 }))
    const noCaller = await loadNamespaceFacts(
      { read, matrix: builder() },
      {
        namespace: 'team-a',
        identity: null,
        offeringLabelKey: null,
        target,
        targets: [target],
        tenantLabelKey: null,
        admissionFacts: []
      }
    )

    expect(noCaller.fact.access).toBe(null)
    expect(noCaller.fact.mayCreate).toBe('unknown')
    expect(noCaller.fact.quota).toBe(null)
    expect(noCaller.degraded).toEqual([
      { source: 'resourcequotas', status: 403, message: expect.stringContaining('403') }
    ])

    const unsure = await loadNamespaceFacts(
      { read: fakeReader(routes()).read, matrix: builder({ ...matrix, '/secrets': row('unknown') }) },
      {
        namespace: 'team-a',
        identity,
        offeringLabelKey: null,
        target,
        targets: [target],
        tenantLabelKey: null,
        admissionFacts: []
      }
    )

    expect(unsure.fact.mayCreate).toBe('unknown')
    expect(unsure.degraded).toEqual([
      {
        source: 'subjectaccessreviews',
        status: 0,
        message: expect.stringContaining('could not be evaluated')
      }
    ])
  })
})
