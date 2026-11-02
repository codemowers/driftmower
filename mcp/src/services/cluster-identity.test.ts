import { describe, expect, it, vi } from 'vitest'
import { clusterIdentity, clusterInstructions } from '../domain/cluster-identity.js'
import { discoverClusterIdentity } from './cluster-identity.js'

const fallback = clusterIdentity('ee-west-1.codemowers.io', 'https://10.250.10.2:6443', 'https://mcp.example')

describe('kubelogin cluster discovery', () => {
  it('uses the ingress hostname for the public API, cluster name and namespace contexts', async () => {
    const cluster = await discoverClusterIdentity(
      fallback,
      async () => ({
        spec: { rules: [{ host: 'kube.aws-us-west-2-bravo.codemowers.io' }] }
      }),
      vi.fn(),
      'https://auth.aws-us-west-2-bravo.codemowers.io/'
    )

    expect(cluster).toEqual({
      id: 'aws-us-west-2-bravo.codemowers.io',
      apiUrl: 'https://kube.aws-us-west-2-bravo.codemowers.io',
      mcpServerName: 'driftmower-aws-us-west-2-bravo-codemowers-io',
      authentication: 'passmower-oidc',
      oidcIssuerUrl: 'https://auth.aws-us-west-2-bravo.codemowers.io/'
    })
    const instructions = clusterInstructions(cluster)

    expect(instructions).toContain('aws-us-west-2-bravo.codemowers.io/<namespace>')
    expect(instructions).toContain('--namespace=<namespace>')
    expect(instructions).toContain('Skaffold deploy.kubeContext')
    expect(instructions).toContain('--oidc-client-id=default.kubelogin')
  })

  it.each([404, 403, 503])('retains the k3s address on HTTP %s', async status => {
    const warn = vi.fn()

    expect(
      await discoverClusterIdentity(
        fallback,
        async () => {
          throw new Error(`Kubernetes API returned HTTP ${status}`)
        },
        warn
      )
    ).toBe(fallback)
    expect(warn).toHaveBeenCalledTimes(status === 404 ? 0 : 1)
    expect(clusterInstructions(fallback)).not.toContain('exposes this Kubernetes API via Passmower')
  })

  it.each([
    {},
    { spec: {} },
    { spec: { rules: [{ host: '*.example.com' }] } },
    { spec: { rules: [{ host: 'kube.one.example' }, { host: 'kube.two.example' }] } },
    { spec: { rules: [{ host: 'bad.example/path' }] } }
  ])('retains fallback for unusable ingress %j', async ingress => {
    expect(await discoverClusterIdentity(fallback, async () => ingress, vi.fn())).toBe(fallback)
  })

  it('strips only the leading kube label', async () => {
    const cluster = await discoverClusterIdentity(
      fallback,
      async () => ({
        spec: { rules: [{ host: 'api.kube.example' }] }
      }),
      vi.fn()
    )

    expect(cluster.id).toBe('api.kube.example')
  })
})
