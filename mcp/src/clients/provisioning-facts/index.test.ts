import { describe, expect, it, vi } from 'vitest'
import { fakeReader, list } from '../../../test/fake-kubernetes-reader.js'
import type { AccessChecker } from '../access-check.js'
import type { ClusterCapabilitiesDiscovery } from '../cluster-capabilities.js'
import type { ClusterCatalog } from '../cluster-catalog.js'
import { createProvisioningFacts } from './index.js'

const groups = [
  { name: 'postgresql.cnpg.io', versions: [{ version: 'v1' }] },
  { name: 'apps', versions: [{ version: 'v1' }] },
  { name: 'networking.k8s.io', versions: [{ version: 'v1' }] },
  { name: 'cert-manager.io', versions: [{ version: 'v1' }] },
  { name: 'monitoring.coreos.com', versions: [{ version: 'v1' }] }
]

function cluster(overrides: Record<string, unknown> = {}) {
  const { read, calls } = fakeReader({
    '/apis': { groups },
    '/apis/postgresql.cnpg.io/v1': { resources: [{ name: 'clusters', kind: 'Cluster', namespaced: true }] },
    '/apis/apps/v1': { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true }] },
    '/apis/networking.k8s.io/v1': {
      resources: [{ name: 'networkpolicies', kind: 'NetworkPolicy', namespaced: true }]
    },
    '/apis/cert-manager.io/v1': { resources: [] },
    '/apis/monitoring.coreos.com/v1': { resources: [] },
    '/api/v1/nodes': list([
      {
        metadata: { labels: { 'topology.kubernetes.io/zone': 'a' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '4', memory: '8Gi' } }
      }
    ]),
    '/apis/kyverno.io/v1/clusterpolicies': 404,
    '/apis/apps/v1/deployments': list([
      {
        metadata: {
          name: 'cnpg-cloudnative-pg',
          namespace: 'ops',
          labels: { 'app.kubernetes.io/version': '1.24' }
        },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 }
      }
    ]),
    ...overrides
  })
  const catalog = {
    listStorageClasses: vi.fn().mockResolvedValue({
      storageClasses: [
        {
          name: 'gp3',
          provisioner: 'ebs.csi.aws.com',
          reclaimPolicy: 'Delete',
          volumeBindingMode: 'WaitForFirstConsumer',
          allowVolumeExpansion: true,
          isDefault: true
        }
      ]
    }),
    listAdmissionPolicies: vi.fn().mockResolvedValue({ policies: [], unavailableKinds: [] })
  } as unknown as ClusterCatalog
  const capabilities = {
    listPlatformClasses: vi.fn().mockResolvedValue({
      ingressClasses: [{ name: 'traefik', controller: 'traefik.io/ingress-controller', isDefault: true }],
      priorityClasses: [{ name: 'default', value: 0, isDefault: true, description: null }],
      clusterIssuers: [{ name: 'letsencrypt', description: null, ready: true }],
      degraded: []
    })
  } as unknown as ClusterCapabilitiesDiscovery
  const checker = {
    mayPerform: vi.fn().mockResolvedValue({ verdict: 'yes', reason: null })
  } as unknown as AccessChecker
  let clock = 0
  const facts = createProvisioningFacts({
    read,
    checker,
    catalog,
    capabilities,
    ingressDomainSuffix: 'example.io',
    clusterFactTtlMs: 1000,
    topologyTtlMs: 100,
    operatorTtlMs: 100,
    now: () => clock
  })

  return { facts, calls, catalog, capabilities, advance: (ms: number) => (clock += ms) }
}

describe('createProvisioningFacts', () => {
  it('gathers every cluster fact from one set of reads and ranks offerings by availability', async () => {
    const { facts, capabilities } = cluster()
    const result = await facts.cluster()

    expect(result.offerings[0]).toMatchObject({
      id: 'postgres',
      resource: 'clusters.postgresql.cnpg.io',
      availability: { state: 'ready', version: '1.24' }
    })
    expect(result.offerings.slice(1).every(card => card.availability.state === 'not-installed')).toBe(true)
    expect(result.targets.find(target => target.id === 'postgres')?.resources[0]).toEqual({
      group: 'postgresql.cnpg.io',
      resource: 'clusters'
    })
    expect(result.targets.find(target => target.id === 'emqx')?.resources[0].resource).toBe(null)
    expect(result.storageClasses[0]).toMatchObject({ name: 'gp3', topology: 'zonal', replicaSafe: true })
    expect(result.topology.schedulableNodes).toBe(1)
    expect(result.policies).toEqual([])
    expect(result.ingress).toMatchObject({
      domainSuffix: { value: 'example.io', source: 'config' },
      clusterIssuers: ['letsencrypt'],
      tlsAdvice: expect.stringContaining('letsencrypt')
    })
    expect(result.priorityClasses[0].meaning).toContain('automatically')
    expect(result.networkPolicyEngine).toBe('native')
    expect(result.monitoringOperator).toBe(true)
    expect(result.tenantLabelKey).toBe(null)
    expect(result.degraded).toEqual([])
    expect(capabilities.listPlatformClasses).toHaveBeenCalledWith('v1')
  })

  it('memoises cluster facts until the TTL passes and forgets them on invalidate', async () => {
    const { facts, calls, advance } = cluster()

    await facts.cluster()
    const after = calls.length

    await facts.cluster()
    expect(calls.length).toBe(after)
    advance(1001)
    await facts.cluster()
    expect(calls.length).toBeGreaterThan(after)
    const before = calls.length

    facts.invalidate()
    await facts.cluster()
    expect(calls.length).toBeGreaterThan(before)
  })

  it('degrades refused reads by name and keeps going', async () => {
    const { facts } = cluster({ '/api/v1/nodes': 403, '/apis/apps/v1/deployments': 403 })
    const result = await facts.cluster()

    expect(result.degraded.map(entry => entry.source).sort()).toEqual(['deployments', 'nodes'])
    expect(result.topology.schedulableNodes).toBe(0)
    expect(result.offerings[0].availability.state).toBe('crds-only')
  })
})
