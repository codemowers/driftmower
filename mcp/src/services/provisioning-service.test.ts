import { describe, expect, it, vi } from 'vitest'
import type { AccessChecker } from '../clients/access-check.js'
import type { ClusterFacts, ProvisioningFacts } from '../clients/provisioning-facts/index.js'
import type { NamespaceFactsResult } from '../clients/provisioning-facts/namespace.js'
import { VERBS } from '../domain/provisioning/access-facts.js'
import { toAdmissionFacts, toAdmissionFact } from '../domain/provisioning/admission-facts.js'
import { fromResourceLists } from '../domain/provisioning/api-surface.js'
import type { NamespaceFact, OfferingCard } from '../domain/provisioning/types.js'
import {
  formatAccessCheck,
  formatNamespaceReadiness,
  formatOfferings,
  formatProvisioningPlatform,
  formatUnavailable
} from './provisioning-format.js'
import { ProvisioningService } from './provisioning-service.js'

const identity = { user: 'issuer#alice', groups: ['system:authenticated'] }
const row = (create: 'yes' | 'no' | 'unknown' = 'yes') =>
  Object.fromEntries(VERBS.map(verb => [verb, verb === 'create' ? create : 'yes'])) as Record<
    (typeof VERBS)[number],
    'yes' | 'no' | 'unknown'
  >

const guard = toAdmissionFacts(
  [
    {
      metadata: { name: 'sandbox-ingress-guard' },
      spec: {
        matchConstraints: {
          resourceRules: [
            { apiGroups: ['networking.k8s.io'], operations: ['CREATE'], resources: ['ingresses'] }
          ]
        },
        variables: [{ name: 's', expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']" }],
        validations: [{ message: 'Ingress hosts must be <sandbox-id>.<domain>' }]
      }
    }
  ],
  [{ spec: { policyName: 'sandbox-ingress-guard', validationActions: ['Deny'] } }]
)

const postgres: OfferingCard = {
  id: 'postgres',
  name: 'PostgreSQL',
  purpose: 'relational',
  what: 'A relational database.',
  goodFor: ['application data'],
  operator: { name: 'CloudNativePG', vendor: 'cloudnative-pg', docsHref: 'https://cloudnative-pg.io' },
  resource: 'clusters.postgresql.cnpg.io',
  apiVersion: 'postgresql.cnpg.io/v1',
  availability: { state: 'ready', version: '1.24.0', watchedNamespaces: 'all' },
  presets: [],
  needs: []
}
const dragonfly: OfferingCard = {
  ...postgres,
  id: 'dragonfly',
  name: 'Dragonfly',
  purpose: 'cache',
  what: 'An in-memory cache.',
  resource: null,
  apiVersion: null,
  availability: { state: 'not-installed', installHref: null },
  needs: ['The Dragonfly operator']
}

function clusterFacts(overrides: Partial<ClusterFacts> = {}): ClusterFacts {
  return {
    surface: fromResourceLists([]),
    offerings: [postgres, dragonfly],
    targets: [
      { id: 'postgres', resources: [{ group: 'postgresql.cnpg.io', resource: 'clusters' }] },
      { id: 'dragonfly', resources: [{ group: 'dragonflydb.io', resource: null, reason: 'not served' }] }
    ],
    storageClasses: [
      {
        name: 'postgres',
        provisioner: 'zfs.csi.openebs.io',
        isDefault: false,
        bindingMode: 'Immediate',
        allowExpansion: false,
        reclaimPolicy: 'Retain',
        topology: 'node-local',
        implies: 'lives on one machine',
        replicaSafe: false
      }
    ],
    topology: { zones: [], schedulableNodes: 3, controlPlaneLabel: null },
    policies: [],
    admission: guard,
    admissionPolicies: guard.map(toAdmissionFact),
    tenantLabelKey: 'codemowers.io/sandbox',
    ingress: {
      domainSuffix: { value: 'ee-lte-1.codemowers.io', source: 'guard-params' },
      classes: [{ name: 'traefik', controller: 'traefik.io/ingress-controller', isDefault: true }],
      clusterIssuers: ['letsencrypt'],
      tlsAdvice: 'Request a certificate from the letsencrypt ClusterIssuer.'
    },
    priorityClasses: [{ name: 'standard', value: 0, isDefault: true, meaning: 'The default.' }],
    networkPolicyEngine: 'native',
    monitoringOperator: true,
    degraded: [],
    ...overrides
  }
}

function namespaceFact(
  namespace: string,
  view: 'yes' | 'no' | 'unknown',
  tenant = true
): NamespaceFactsResult {
  const matrix = {
    '/pods': { ...row(), list: view },
    'postgresql.cnpg.io/clusters': row(),
    'networking.k8s.io/networkpolicies': row()
  }
  const fact: NamespaceFact = {
    namespace,
    tenant: tenant ? { labelKey: 'codemowers.io/sandbox', id: 'abc123-foo' } : null,
    sandbox: tenant ? 'abc123-foo' : null,
    quota: { name: 'sandbox', used: { 'requests.memory': '1Gi' }, hard: { 'requests.memory': '2Gi' } },
    headroom: { cpuMillis: 1500, memoryBytes: 1024 ** 3, storageBytes: 10 * 1024 ** 3, pvcCount: 4, pods: 8 },
    limitRange: { defaultRequest: { memory: '64Mi' }, default: { memory: '256Mi' } },
    network: {
      ingress: 'default-deny',
      egress: 'default-deny',
      selectors: [
        {
          policy: 'cnpg-operator',
          kind: 'NetworkPolicy',
          direction: 'Ingress',
          labelKey: 'cnpg.io/cluster',
          labelValue: 'database',
          admits: 'operator traffic on 8000'
        }
      ],
      ciliumAvailable: false
    },
    access: {
      matrix,
      view,
      edit: 'yes',
      admin: 'no',
      provision: { postgres: 'yes', dragonfly: 'unknown' },
      provisionDetail: {
        postgres: [{ resource: 'clusters.postgresql.cnpg.io', verdict: 'yes', reason: null }],
        dragonfly: [{ resource: '?.dragonflydb.io', verdict: 'unknown', reason: 'not served' }]
      },
      summary: {
        resourceTypes: 3,
        byVerb: Object.fromEntries(VERBS.map(verb => [verb, 3])) as never,
        unknown: 0
      }
    },
    mayCreate: 'yes',
    mayCreateReason:
      'Kubernetes RBAC allows creating clusters.postgresql.cnpg.io, and no enforced admission policy governs it.',
    podSecurity: {
      enforce: 'restricted',
      requires: ['runAsNonRoot'],
      summary: 'Containers cannot run as root.'
    }
  }

  return { fact, labels: tenant ? { 'codemowers.io/sandbox': 'abc123-foo' } : {}, degraded: [] }
}

function service(
  options: {
    cluster?: ClusterFacts
    namespaces?: Record<string, NamespaceFactsResult>
    fail?: Error
    verdict?: 'yes' | 'no' | 'unknown'
  } = {}
) {
  const facts: ProvisioningFacts = {
    cluster: options.fail
      ? vi.fn().mockRejectedValue(options.fail)
      : vi.fn().mockResolvedValue(options.cluster ?? clusterFacts()),
    namespace: vi.fn(async input => {
      const result = options.namespaces?.[input.namespace]

      if (!result) throw new Error(`no fixture for ${input.namespace}`)

      return result
    }),
    invalidate: vi.fn()
  }
  const checker = {
    mayPerform: vi
      .fn()
      .mockResolvedValue({
        verdict: options.verdict ?? 'yes',
        reason: options.verdict === 'no' ? 'Kubernetes RBAC denies it' : null
      })
  } as unknown as AccessChecker

  return { service: new ProvisioningService({ facts, checker, maxNamespaces: 3 }), facts, checker }
}

describe('ProvisioningService', () => {
  it('withholds a namespace the caller may not see and explains an inconclusive one', async () => {
    const { service: subject, facts } = service({
      namespaces: {
        mine: namespaceFact('mine', 'yes'),
        theirs: namespaceFact('theirs', 'no'),
        odd: namespaceFact('odd', 'unknown')
      }
    })
    const result = await subject.describeNamespaceReadiness(identity, ['mine', ' mine ', 'theirs', 'odd'])

    expect(result.status).toBe('ok')

    if (result.status !== 'ok') return

    expect(facts.namespace).toHaveBeenCalledTimes(3)
    expect(result.requested).toEqual(['mine', 'theirs', 'odd'])
    expect(result.namespaces.map(fact => fact.namespace)).toEqual(['mine'])
    expect(result.withheld).toEqual(['theirs', 'odd'])
    expect(result.degraded).toEqual([
      { source: 'subjectaccessreviews', status: 0, message: expect.stringContaining('odd') }
    ])
    const markdown = formatNamespaceReadiness(result)

    expect(markdown).toContain('`theirs`, `odd`')
    expect(markdown).toContain('Access (from the cluster authorizer): may create 3 of 3 resource types')
    expect(markdown).toContain('Provision: postgres yes, dragonfly unknown (?.dragonflydb.io)')
    expect(markdown).toContain('exact instance name')
    expect(markdown).toContain('abc123-foo.ee-lte-1.codemowers.io')
  })

  it('returns everything for an unauthenticated caller with permission marked unknown, not withheld', async () => {
    const fixture = namespaceFact('mine', 'yes')

    fixture.fact.access = null
    fixture.fact.mayCreate = 'unknown'
    const { service: subject } = service({ namespaces: { mine: fixture } })
    const result = await subject.describeNamespaceReadiness(null, ['mine'])

    expect(result).toMatchObject({
      status: 'ok',
      withheld: [],
      namespaces: [{ namespace: 'mine', access: null }]
    })
  })

  it('rejects a fan-out beyond the configured cap', async () => {
    const { service: subject } = service()

    expect(await subject.describeNamespaceReadiness(identity, ['a', 'b', 'c', 'd'])).toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('At most 3 namespaces')
    })
  })

  it('derives host rules only where a guard, a tenant id and a suffix all exist', async () => {
    const { service: subject } = service({
      namespaces: { tenant: namespaceFact('tenant', 'yes'), plain: namespaceFact('plain', 'yes', false) }
    })
    const result = await subject.describeNamespaceReadiness(identity, ['tenant', 'plain'])

    if (result.status !== 'ok') throw new Error(result.detail)

    expect(result.hostRules[0]).toMatchObject({
      namespace: 'tenant',
      tenantId: 'abc123-foo',
      exactHost: 'abc123-foo.ee-lte-1.codemowers.io',
      enforcedBy: 'sandbox-ingress-guard',
      enforcedMessage: expect.stringContaining('host')
    })
    expect(result.hostRules[1]).toMatchObject({
      namespace: 'plain',
      exactHost: null,
      enforcedBy: null,
      note: expect.stringContaining('convention, not a rule')
    })
  })

  it('adds a per-namespace verdict to offerings when a namespace is named', async () => {
    const { service: subject } = service({ namespaces: { mine: namespaceFact('mine', 'yes') } })
    const plain = await subject.listOfferings(identity)
    const scoped = await subject.listOfferings(identity, undefined, 'mine')

    if (plain.status !== 'ok' || scoped.status !== 'ok') throw new Error('unexpected')

    expect(plain.offerings[0].mayCreate).toBeUndefined()
    expect(scoped.offerings.map(card => [card.id, card.mayCreate])).toEqual([
      ['postgres', 'yes'],
      ['dragonfly', 'unknown']
    ])
    expect(scoped.offerings[0].mayCreateReason).toContain('mine')
    expect(formatOfferings(scoped)).toContain('May you create it there: **yes**')
    expect(formatOfferings(plain)).toContain('1 of 2 ready')
    expect(formatOfferings(plain)).toContain('Before it could be used here: The Dragonfly operator')
  })

  it('reports an unreadable Kubernetes API as a named failure, not a crash', async () => {
    const { service: subject } = service({ fail: new Error('connect ECONNREFUSED') })
    const result = await subject.describeProvisioningPlatform()

    expect(result).toMatchObject({ status: 'unavailable', reason: 'kubernetes_unreachable' })

    if (result.status !== 'unavailable') return

    expect(formatUnavailable(result)).toContain('connect ECONNREFUSED')
  })

  it('describes the platform with storage implications, the guard and the tenant label', async () => {
    const { service: subject } = service()
    const result = await subject.describeProvisioningPlatform()

    if (result.status !== 'ok') throw new Error(result.detail)

    expect(result).toMatchObject({
      offeringsReady: 1,
      offeringsTotal: 2,
      tenantLabelKey: 'codemowers.io/sandbox'
    })
    const markdown = formatProvisioningPlatform(result)

    expect(markdown).toContain('1 of 2 offerings ready')
    expect(markdown).toContain('lives on one machine')
    expect(markdown).toContain('sandbox-ingress-guard')
    expect(markdown).toContain('`codemowers.io/sandbox`')
    expect(markdown).toContain('`ee-lte-1.codemowers.io`')
  })

  it('surfaces degraded reads as unknown rather than dropping them', async () => {
    const { service: subject } = service({
      cluster: clusterFacts({
        degraded: [{ source: 'nodes', status: 403, message: 'Not authorized to read nodes (403)' }]
      })
    })
    const result = await subject.describeProvisioningPlatform()

    if (result.status !== 'ok') throw new Error(result.detail)

    expect(formatProvisioningPlatform(result)).toContain('Facts that could not be read')
    expect(formatProvisioningPlatform(result)).toContain('Not authorized to read nodes')
  })

  it('answers an exact permission question with admission composed on top', async () => {
    const { service: subject, checker } = service({ namespaces: { tenant: namespaceFact('tenant', 'yes') } })
    const ingress = { namespace: 'tenant', verb: 'create', group: 'networking.k8s.io', resource: 'ingresses' }
    const governed = await subject.checkAccess(identity, ingress)

    expect(governed).toMatchObject({
      status: 'ok',
      verdict: 'no',
      reason: expect.stringContaining('sandbox-ingress-guard'),
      rbac: { verdict: 'yes' }
    })
    expect(checker.mayPerform).toHaveBeenCalledWith(identity, {
      namespace: 'tenant',
      verb: 'create',
      group: 'networking.k8s.io',
      resource: 'ingresses',
      subresource: undefined,
      name: undefined
    })
    const logs = await subject.checkAccess(identity, {
      namespace: 'tenant',
      verb: 'get',
      group: '',
      resource: 'pods',
      subresource: 'log',
      name: 'api'
    })

    expect(logs).toMatchObject({ verdict: 'yes', admission: [] })

    if (logs.status === 'ok')
      expect(
        formatAccessCheck(logs, { verb: 'get', group: '', resource: 'pods', namespace: 'tenant' })
      ).toContain('issuer#alice')

    expect(await subject.checkAccess(null, { verb: 'list', group: '', resource: 'nodes' })).toMatchObject({
      verdict: 'unknown',
      identity: null
    })
  })
})
