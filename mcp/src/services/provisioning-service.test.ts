import { describe, expect, it, vi } from 'vitest'
import type { CapabilitiesResult, DriftmowerUiClient } from '../clients/driftmower-ui.js'
import type { CapabilityResponse } from '../domain/provisioning.js'
import {
  formatClusterCapabilities,
  formatNamespaceReadiness,
  formatOfferings,
  formatUnavailable
} from './provisioning-format.js'
import { ProvisioningService } from './provisioning-service.js'

// A capability payload shaped like driftmower-ui's, trimmed to the fields these
// tools read. Storage facts here retain the upstream UI capability format.
function capabilities(overrides: Partial<CapabilityResponse> = {}): CapabilityResponse {
  return {
    inCluster: true,
    offerings: [
      {
        id: 'postgres',
        name: 'PostgreSQL',
        purpose: 'relational',
        what: 'A relational database.',
        goodFor: ['application data'],
        operator: { name: 'CloudNativePG', vendor: 'EDB', docsHref: 'https://cloudnative-pg.io' },
        resource: 'clusters.postgresql.cnpg.io',
        apiVersion: 'postgresql.cnpg.io/v1',
        availability: { state: 'ready', version: '1.24.0', watchedNamespaces: 'all' },
        presets: [],
        needs: [],
        instanceCount: 2
      },
      {
        id: 'dragonfly',
        name: 'Dragonfly',
        purpose: 'cache',
        what: 'An in-memory cache.',
        goodFor: ['sessions'],
        operator: { name: 'dragonfly-operator', vendor: 'DragonflyDB', docsHref: 'https://dragonflydb.io' },
        resource: null,
        apiVersion: null,
        availability: { state: 'not-installed', installHref: null },
        presets: [],
        needs: ['the dragonfly-operator to be installed on this cluster'],
        instanceCount: 0
      }
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
        implies: 'Tuned for PostgreSQL, but the volume lives on one machine.',
        replicaSafe: false
      }
    ],
    topology: { zones: [], schedulableNodes: 3, controlPlaneLabel: null },
    namespaces: [
      {
        namespace: 'sandbox-foo',
        sandbox: 'abc123-foo',
        quota: { name: 'sandbox', used: { 'requests.memory': '1Gi' }, hard: { 'requests.memory': '2Gi' } },
        headroom: {
          cpuMillis: 1500,
          memoryBytes: 1024 ** 3,
          storageBytes: 10 * 1024 ** 3,
          pvcCount: 4,
          pods: 8
        },
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
        mayCreate: 'likely',
        mayCreateReason: 'you hold the namespaced admin role here',
        podSecurity: {
          enforce: 'restricted',
          requires: ['runAsNonRoot', 'seccompProfile'],
          summary: 'Containers cannot run as root.'
        }
      }
    ],
    policies: [],
    admissionPolicies: [
      {
        name: 'sandbox-ingress-guard',
        enforced: true,
        enforcement: 'Deny',
        guards: [{ group: 'networking.k8s.io', resource: 'ingresses', operations: ['CREATE'] }],
        messages: ['host must be <sandbox-id>.ee-lte-1.codemowers.io'],
        scopedToNamespaceLabels: { 'codemowers.io/sandbox': 'abc123-foo' }
      }
    ],
    ingress: {
      domainSuffix: 'ee-lte-1.codemowers.io',
      domainSuffixSource: 'guard-params',
      classes: [{ name: 'traefik', controller: 'traefik.io/ingress-controller', isDefault: true }],
      clusterIssuers: ['letsencrypt'],
      sharedWildcard: false,
      tlsAdvice: 'Request a Certificate against the `letsencrypt` ClusterIssuer.',
      hostRules: [
        {
          namespace: 'sandbox-foo',
          sandboxId: 'abc123-foo',
          exactHost: 'abc123-foo.ee-lte-1.codemowers.io',
          labelledPattern: 'abc123-foo-<label>.ee-lte-1.codemowers.io',
          enforcedBy: 'sandbox-ingress-guard',
          enforcedMessage: 'host must be <sandbox-id>.ee-lte-1.codemowers.io',
          note: 'Only these hostnames are accepted here.'
        }
      ]
    },
    priorityClasses: [{ name: 'standard', value: 0, isDefault: true, meaning: 'The default.' }],
    networkPolicyEngine: 'native',
    monitoringOperator: true,
    degraded: [],
    ...overrides
  }
}

function clientReturning(result: CapabilitiesResult): DriftmowerUiClient {
  return { fetchCapabilities: vi.fn().mockResolvedValue(result) }
}

describe('ProvisioningService', () => {
  it('forwards the caller token and requested namespaces to driftmower-ui', async () => {
    const client = clientReturning({ ok: true, capabilities: capabilities() })
    const service = new ProvisioningService(client)

    await service.describeNamespaceReadiness('caller-token', ['sandbox-foo', ' sandbox-foo ', 'other'])

    expect(client.fetchCapabilities).toHaveBeenCalledWith('caller-token', {
      // Deduplicated and trimmed.
      namespaces: ['sandbox-foo', 'other']
    })
  })

  it('names namespaces that were requested but withheld', async () => {
    const service = new ProvisioningService(clientReturning({ ok: true, capabilities: capabilities() }))

    const result = await service.describeNamespaceReadiness('token', ['sandbox-foo', 'sandbox-bar'])

    expect(result.status).toBe('ok')

    if (result.status !== 'ok') return

    expect(result.withheld).toEqual(['sandbox-bar'])
    expect(formatNamespaceReadiness(result)).toContain('outside your access')
  })

  it('reports an unreachable driftmower-ui as a named failure, not a crash', async () => {
    const service = new ProvisioningService(
      clientReturning({ ok: false, reason: 'unreachable', detail: 'connect ECONNREFUSED' })
    )

    const result = await service.describeClusterCapabilities('token')

    expect(result).toMatchObject({ status: 'unavailable', reason: 'unreachable' })

    if (result.status !== 'unavailable') return

    expect(formatUnavailable(result)).toContain('connect ECONNREFUSED')
  })

  it('treats an out-of-cluster driftmower-ui as unavailable rather than an empty cluster', async () => {
    const service = new ProvisioningService(
      clientReturning({ ok: true, capabilities: capabilities({ inCluster: false }) })
    )

    const result = await service.describeClusterCapabilities('token')

    expect(result).toMatchObject({ status: 'unavailable', reason: 'not_in_cluster' })
  })

  it('counts ready offerings and explains why the others are not', async () => {
    const service = new ProvisioningService(clientReturning({ ok: true, capabilities: capabilities() }))

    const listing = await service.listOfferings('token')

    expect(listing.status).toBe('ok')

    if (listing.status !== 'ok') return

    const markdown = formatOfferings(listing)

    expect(markdown).toContain('1 of 2 ready')
    expect(markdown).toContain('not installed on this cluster')
    expect(markdown).toContain('the dragonfly-operator to be installed')
  })

  it('surfaces degraded reads as unknown rather than dropping them', async () => {
    const service = new ProvisioningService(
      clientReturning({
        ok: true,
        capabilities: capabilities({
          degraded: [
            { source: 'storageclasses', status: 403, message: 'the service account may not list these' }
          ]
        })
      })
    )

    const result = await service.describeClusterCapabilities('token')

    expect(result.status).toBe('ok')

    if (result.status !== 'ok') return

    const markdown = formatClusterCapabilities(result)

    expect(markdown).toContain('Facts that could not be read')
    expect(markdown).toContain('they did not come back empty')
    expect(markdown).toContain('the service account may not list these')
  })

  it('warns about policies that select on an exact instance name', async () => {
    // The single most likely support ticket on these clusters: name a database
    // anything but `database` and it silently never reports ready.
    const service = new ProvisioningService(clientReturning({ ok: true, capabilities: capabilities() }))

    const result = await service.describeNamespaceReadiness('token', ['sandbox-foo'])

    expect(result.status).toBe('ok')

    if (result.status !== 'ok') return

    const markdown = formatNamespaceReadiness(result)

    expect(markdown).toContain('exact instance name')
    expect(markdown).toContain('cnpg.io/cluster=database')
    expect(markdown).toContain('abc123-foo.ee-lte-1.codemowers.io')
    expect(markdown).toContain('256Mi')
  })
})
