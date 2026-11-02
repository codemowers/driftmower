import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { clusterCapabilitiesShape, createClusterCapabilities } from './cluster-capabilities.js'

const issuerCrd = {
  metadata: { name: 'clusterissuers.cert-manager.io' },
  spec: {
    group: 'cert-manager.io',
    names: { kind: 'ClusterIssuer', plural: 'clusterissuers' },
    scope: 'Cluster',
    versions: [{ name: 'v1', served: true, storage: true }]
  },
  status: { conditions: [{ type: 'Established', status: 'True' }] }
}

function reader(issuers: (path: string) => object, installed = true) {
  return vi.fn(async (path: string) => {
    if (path.startsWith('/apis/apiextensions.k8s.io/')) {
      return JSON.stringify({ items: installed ? [issuerCrd] : [] })
    }

    if (path.startsWith('/apis/cert-manager.io/v1/clusterissuers?')) {
      return JSON.stringify(issuers(path))
    }

    if (path.startsWith('/apis/networking.k8s.io/') || path.startsWith('/apis/scheduling.k8s.io/')) {
      return JSON.stringify({ items: [] })
    }

    throw new Error(`Unexpected read: ${path}`)
  })
}

describe('TLS issuer capability discovery', () => {
  it('returns live descriptions and readiness across pages without exposing issuer configuration', async () => {
    const read = reader((path) =>
      path.includes('continue=')
        ? {
            items: [
              { metadata: { name: 'pending' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } },
              {
                metadata: { name: 'unknown' },
                status: { conditions: [{ type: 'Ready', status: 'Unknown' }] }
              },
              { metadata: { name: 'new' } }
            ]
          }
        : {
            metadata: { continue: 'next/+=' },
            items: [
              {
                metadata: {
                  name: 'letsencrypt',
                  annotations: {
                    'kubernetes.io/description': 'Public TLS for externally reachable hostnames.',
                    'kubectl.kubernetes.io/last-applied-configuration': 'private configuration'
                  }
                },
                spec: {
                  acme: {
                    privateKeySecretRef: { name: 'account-key' },
                    solvers: [{ http01: { ingress: { ingressClassName: 'traefik' } } }]
                  }
                },
                status: { conditions: [{ type: 'Ready', status: 'True' }] }
              },
              {
                metadata: {
                  name: 'cluster-tls-issuer',
                  annotations: { 'kubernetes.io/description': 'In-cluster TLS; trust the internal CA.' }
                },
                status: { conditions: [{ type: 'Ready', status: 'True' }] }
              }
            ]
          }
    )
    const result = await createClusterCapabilities(read).describe()

    expect(result.clusterIssuers).toEqual([
      // Only which challenge types the solvers offer, never their configuration.
      {
        name: 'letsencrypt',
        description: 'Public TLS for externally reachable hostnames.',
        ready: true,
        acme: { http01: true, dns01: false }
      },
      { name: 'cluster-tls-issuer', description: 'In-cluster TLS; trust the internal CA.', ready: true, acme: null },
      { name: 'pending', description: null, ready: false, acme: null },
      { name: 'unknown', description: null, ready: null, acme: null },
      { name: 'new', description: null, ready: null, acme: null }
    ])
    expect(JSON.stringify(result)).not.toContain('account-key')
    expect(z.object(clusterCapabilitiesShape).parse(result)).toEqual(result)
    expect(result.degraded).toEqual([])
    expect(read).toHaveBeenCalledWith(
      '/apis/cert-manager.io/v1/clusterissuers?limit=10&continue=next%2F%2B%3D'
    )
    expect(read.mock.calls.some(([path]) => path.includes('/secrets'))).toBe(false)
  })

  it('reports unavailable issuer reads as degraded instead of an empty issuer list', async () => {
    const read = reader(() => {
      throw new Error('Kubernetes API returned HTTP 403')
    })
    const result = await createClusterCapabilities(read).describe()

    expect(result.clusterIssuers).toBeNull()
    expect(result.degraded).toEqual([
      { source: 'clusterissuers', message: 'Kubernetes API returned HTTP 403' }
    ])
  })

  it('does not query issuer resources when cert-manager is absent', async () => {
    const read = reader(() => {
      throw new Error('Issuer API should not be read')
    }, false)
    const result = await createClusterCapabilities(read).describe()

    expect(result.clusterIssuers).toEqual([])
    expect(result.degraded).toEqual([])
    expect(read.mock.calls.some(([path]) => path.startsWith('/apis/cert-manager.io/'))).toBe(false)
  })
})
