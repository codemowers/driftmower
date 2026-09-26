import { z } from 'zod'
import type { KubernetesIdentity, ObservabilityKubernetes } from './observability-kubernetes.js'

export const accessibleNamespacesSchema = z.object({
  namespaces: z.array(z.string())
})
export interface NamespaceAccess {
  listAccessibleNamespaces(identity: KubernetesIdentity): Promise<z.infer<typeof accessibleNamespacesSchema>>
}

const pageSchema = z.object({
  metadata: z.object({ continue: z.string().optional() }).optional(),
  items: z.array(z.unknown())
})
const namespaceSchema = z.object({ metadata: z.object({ name: z.string() }) })
const bindingSchema = z.object({
  metadata: z.object({ namespace: z.string() }),
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

export function createNamespaceAccess(
  read: (path: string) => Promise<string>,
  allowed: ObservabilityKubernetes['allowed'],
  roleName: string
): NamespaceAccess {
  async function collect(path: string, select: (item: unknown) => string | null): Promise<string[]> {
    const names = new Set<string>()
    let continuation = ''

    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ limit: '500' })

      if (continuation) params.set('continue', continuation)

      const result = pageSchema.parse(JSON.parse(await read(`${path}?${params}`)))

      for (const item of result.items) {
        const name = select(item)

        if (name !== null) names.add(name)
      }

      continuation = result.metadata?.continue ?? ''

      if (!continuation) return [...names].sort()
    }

    throw new Error('Namespace discovery exceeds 20 pages; refusing to return an incomplete list')
  }

  return {
    async listAccessibleNamespaces(identity) {
      if (!identity.user) throw new Error('Namespace discovery requires an authenticated caller')

      if (await allowed(identity, { group: '', resource: 'namespaces', verb: 'list' })) {
        return {
          namespaces: await collect('/api/v1/namespaces', item => namespaceSchema.parse(item).metadata.name)
        }
      }

      const groups = new Set(identity.groups)
      const namespaces = await collect('/apis/rbac.authorization.k8s.io/v1/rolebindings', item => {
        const binding = bindingSchema.parse(item)

        if (
          binding.roleRef.apiGroup !== 'rbac.authorization.k8s.io' ||
          !['Role', 'ClusterRole'].includes(binding.roleRef.kind) ||
          binding.roleRef.name !== roleName
        )
          return null

        const matches = binding.subjects?.some(subject => {
          if (subject.kind === 'ServiceAccount') {
            return (
              (!subject.apiGroup || subject.apiGroup === '') &&
              identity.user ===
                `system:serviceaccount:${subject.namespace ?? binding.metadata.namespace}:${subject.name}`
            )
          }

          if (subject.apiGroup && subject.apiGroup !== 'rbac.authorization.k8s.io') return false

          return (
            (subject.kind === 'User' && subject.name === identity.user) ||
            (subject.kind === 'Group' && groups.has(subject.name))
          )
        })

        return matches ? binding.metadata.namespace : null
      })

      return { namespaces }
    }
  }
}
