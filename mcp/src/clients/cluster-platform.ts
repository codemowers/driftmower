import { z } from 'zod'

export const platformKinds = ['k3s', 'vanilla', 'eks', 'aks'] as const
export type PlatformKind = (typeof platformKinds)[number]
export const clusterPlatformSchema = z.object({
  kind: z.enum([...platformKinds, 'unknown']),
  source: z.enum(['configured', 'discovered', 'unknown']),
  kubernetesVersion: z.string().nullable(),
  evidence: z.array(z.string()),
  note: z.string()
})
export interface ClusterPlatformDiscovery {
  describe(): Promise<z.infer<typeof clusterPlatformSchema>>
}

// Node reads request metadata only. Export recognized marker names, never node
// names, arbitrary labels, provider account IDs or addresses.
export function createClusterPlatformDiscovery(
  read: (path: string, metadataOnly?: boolean) => Promise<string>,
  configured?: PlatformKind
): ClusterPlatformDiscovery {
  return {
    async describe() {
      if (configured) {
        return {
          kind: configured,
          source: 'configured' as const,
          kubernetesVersion: null,
          evidence: ['Administrator configuration: DRIFTMOWER_CLUSTER_PLATFORM'],
          note: 'Administrator-declared platform. Discover available services, CRDs and applicable policy bindings separately.'
        }
      }

      const version = z.object({ gitVersion: z.string() }).parse(JSON.parse(await read('/version')))
      const found = new Set<PlatformKind>()
      const evidence = new Set<string>()

      if (/\+k3s\d/i.test(version.gitVersion)) {
        found.add('k3s')
        evidence.add('API server gitVersion has a k3s suffix')
      }

      if (/-eks-/i.test(version.gitVersion)) {
        found.add('eks')
        evidence.add('API server gitVersion has an eks suffix')
      }

      // AKS can report an upstream-looking version. Absence of a distribution
      // suffix is not enough evidence to call a cluster vanilla Kubernetes.
      if (!found.size) {
        let continuation = ''

        for (let page = 0; page < 200; page += 1) {
          const query = new URLSearchParams({ limit: '100' })

          if (continuation) query.set('continue', continuation)

          const nodes = z
            .object({
              metadata: z.object({ continue: z.string().optional() }).optional(),
              items: z.array(
                z.object({ metadata: z.object({ labels: z.record(z.string(), z.string()).optional() }) })
              )
            })
            .parse(JSON.parse(await read(`/api/v1/nodes?${query}`, true)))

          for (const node of nodes.items) {
            const labels = node.metadata.labels ?? {}

            for (const [key, kind] of [
              ['kubernetes.azure.com/cluster', 'aks'],
              ['eks.amazonaws.com/nodegroup', 'eks'],
              ['eks.amazonaws.com/compute-type', 'eks']
            ] as const) {
              if (labels[key]) {
                found.add(kind)
                evidence.add(`Node metadata includes ${key}`)
              }
            }
          }

          continuation = nodes.metadata?.continue ?? ''

          if (!continuation) break

          if (page === 199) throw new Error('Platform discovery exceeded its node page limit')
        }
      }

      const kind = found.size === 1 ? [...found][0] : 'unknown'

      return {
        kind,
        source: kind === 'unknown' ? ('unknown' as const) : ('discovered' as const),
        kubernetesVersion: version.gitVersion,
        evidence: [...evidence].sort(),
        note:
          kind === 'unknown'
            ? 'Platform is unknown or markers conflict. Confirm with the administrator; set DRIFTMOWER_CLUSTER_PLATFORM for a verified platform, including vanilla. Kubernetes version or cloud hosting alone does not identify a managed service.'
            : 'Platform inferred from distribution markers, not a guarantee of available managed services, operators or permissions.'
      }
    }
  }
}
