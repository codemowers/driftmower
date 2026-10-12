import { z } from 'zod'
import type { KubernetesIdentity } from './observability-kubernetes.js'

export const kubernetesRoleSchema = z.enum(['cluster-admin', 'restricted'])
export interface KubernetesRoleDiscovery {
  getRole(identity: KubernetesIdentity): Promise<z.infer<typeof kubernetesRoleSchema>>
}

const pageSchema = z.object({
  metadata: z.object({ continue: z.string().optional() }).optional(),
  items: z.array(
    z.object({
      roleRef: z.object({ apiGroup: z.string(), kind: z.string(), name: z.string() }),
      subjects: z
        .array(
          z.object({
            kind: z.string(),
            name: z.string(),
            apiGroup: z.string().optional(),
            namespace: z.string().optional()
          })
        )
        .optional()
    })
  )
})

export function createKubernetesRoleDiscovery(
  read: (path: string) => Promise<string>
): KubernetesRoleDiscovery {
  return {
    async getRole(identity) {
      if (!identity.user) throw new Error('Role discovery requires an authenticated caller')

      const groups = new Set(identity.groups)
      let continuation = ''

      for (let page = 0; page < 20; page += 1) {
        const params = new URLSearchParams({ limit: '500' })

        if (continuation) params.set('continue', continuation)

        const result = pageSchema.parse(
          JSON.parse(await read(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?${params}`))
        )

        for (const binding of result.items) {
          if (
            binding.roleRef.apiGroup !== 'rbac.authorization.k8s.io' ||
            binding.roleRef.kind !== 'ClusterRole' ||
            binding.roleRef.name !== 'cluster-admin'
          )
            continue

          const matches = binding.subjects?.some(subject => {
            if (subject.kind === 'ServiceAccount') {
              return (
                (!subject.apiGroup || subject.apiGroup === '') &&
                Boolean(subject.namespace) &&
                identity.user === `system:serviceaccount:${subject.namespace}:${subject.name}`
              )
            }

            if (subject.apiGroup && subject.apiGroup !== 'rbac.authorization.k8s.io') return false

            return (
              (subject.kind === 'User' && subject.name === identity.user) ||
              (subject.kind === 'Group' && groups.has(subject.name))
            )
          })

          if (matches) return 'cluster-admin'
        }

        continuation = result.metadata?.continue ?? ''

        if (!continuation) return 'restricted'
      }

      throw new Error('Role discovery exceeds 20 pages; refusing to report an incomplete result')
    }
  }
}
