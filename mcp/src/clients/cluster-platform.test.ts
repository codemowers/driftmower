import { describe, expect, it, vi } from 'vitest'
import { createClusterPlatformDiscovery } from './cluster-platform.js'

describe('cluster platform discovery', () => {
  it.each([
    ['v1.36.1+k3s1', 'k3s'],
    ['v1.35.2-eks-abc123', 'eks']
  ])('recognizes %s without reading nodes', async (gitVersion, kind) => {
    const read = vi.fn(async () => JSON.stringify({ gitVersion }))

    expect(await createClusterPlatformDiscovery(read).describe()).toMatchObject({
      kind,
      source: 'discovered',
      kubernetesVersion: gitVersion
    })
    expect(read).toHaveBeenCalledExactlyOnceWith('/version')
  })

  it('finds AKS on later pages and exports marker names without node metadata values', async () => {
    const read = vi.fn(async (path: string) =>
      JSON.stringify(
        path === '/version'
          ? { gitVersion: 'v1.36.0' }
          : path.includes('continue=next')
            ? {
                items: [
                  {
                    metadata: {
                      name: 'private-node',
                      labels: { 'kubernetes.azure.com/cluster': 'private-group', unrelated: 'sensitive' }
                    }
                  }
                ]
              }
            : { metadata: { continue: 'next' }, items: [] }
      )
    )
    const result = await createClusterPlatformDiscovery(read).describe()

    expect(result).toMatchObject({ kind: 'aks', source: 'discovered' })
    expect(read).toHaveBeenCalledWith('/api/v1/nodes?limit=100&continue=next', true)
    expect(JSON.stringify(result)).not.toMatch(/private-node|private-group|sensitive/)
  })

  it('does not mistake generic versions or cloud provider labels for vanilla or managed Kubernetes', async () => {
    const read = async (path: string) =>
      JSON.stringify(
        path === '/version'
          ? { gitVersion: 'v1.36.0' }
          : { items: [{ metadata: { labels: { 'topology.kubernetes.io/region': 'us-east-1' } } }] }
      )

    expect(await createClusterPlatformDiscovery(read).describe()).toMatchObject({
      kind: 'unknown',
      source: 'unknown'
    })
  })

  it('reports conflicting managed-platform markers as unknown', async () => {
    const read = async (path: string) =>
      JSON.stringify(
        path === '/version'
          ? { gitVersion: 'v1.36.0' }
          : {
              items: [
                {
                  metadata: {
                    labels: { 'kubernetes.azure.com/cluster': 'azure', 'eks.amazonaws.com/nodegroup': 'aws' }
                  }
                }
              ]
            }
      )

    expect(await createClusterPlatformDiscovery(read).describe()).toMatchObject({ kind: 'unknown' })
  })

  it.each(['k3s', 'vanilla', 'eks', 'aks'] as const)(
    'exports administrator-declared %s without requiring extra reads',
    async kind => {
      const read = vi.fn()

      expect(await createClusterPlatformDiscovery(read, kind).describe()).toMatchObject({
        kind,
        source: 'configured',
        kubernetesVersion: null
      })
      expect(read).not.toHaveBeenCalled()
    }
  )

  it('does not turn denied discovery or malformed responses into platform claims', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ gitVersion: 'v1.36.0' }))
      .mockRejectedValueOnce(new Error('Kubernetes API returned HTTP 403'))

    await expect(createClusterPlatformDiscovery(read).describe()).rejects.toThrow('HTTP 403')
    await expect(createClusterPlatformDiscovery(async () => '{}').describe()).rejects.toThrow()
  })

  it('rejects incomplete pagination rather than exporting partial evidence', async () => {
    const read = async (path: string) =>
      JSON.stringify(
        path === '/version' ? { gitVersion: 'v1.36.0' } : { metadata: { continue: 'next' }, items: [] }
      )

    await expect(createClusterPlatformDiscovery(read).describe()).rejects.toThrow('page limit')
  })
})
