import type { AccessChecker } from './access-check.js'
import { mapWithConcurrency } from './concurrency.js'
import type { KubernetesIdentity } from './observability-kubernetes.js'

// Which namespaces are in a caller's world, decided by the cluster's own
// authorizer rather than by a claim or by reading bindings.
//
// The probe is `list pods`: the weakest verb that means "you can see what runs
// here". It is deliberately only a visibility test. Nothing downstream may read
// a namespace being in scope as permission to change anything in it; every
// write-adjacent answer asks the exact verb and resource separately.

export interface RbacScope {
  // Namespaces where the review answered yes, sorted.
  namespaces: string[]
  // Namespaces where the review could not be evaluated. Excluded, not denied.
  unknown: string[]
  // The caller may list pods in every namespace (a ClusterRoleBinding), so the
  // per-namespace sweep was skipped.
  clusterWide: boolean
  // Namespaces the cluster reported.
  total: number
  // The cluster has more namespaces than the sweep bound; only the first
  // `maxNamespaces` (preferred ones first, then alphabetical) were checked.
  truncated: boolean
  source: 'rbac'
}

export interface RbacScopeResolver {
  resolve(identity: KubernetesIdentity, options?: { preferred?: string[] }): Promise<RbacScope>
}

export interface RbacScopeResolverOptions {
  listNamespaces: () => Promise<string[]>
  checker: AccessChecker
  concurrency?: number
  maxNamespaces?: number
}

export const VISIBILITY_PROBE = { group: '', resource: 'pods', verb: 'list' } as const

export function createRbacScopeResolver(options: RbacScopeResolverOptions): RbacScopeResolver {
  const concurrency = options.concurrency ?? 16
  const maxNamespaces = options.maxNamespaces ?? 2000

  return {
    async resolve(identity, resolveOptions = {}) {
      // No namespace in the review means "in all namespaces", which only a
      // ClusterRoleBinding satisfies. One review instead of one per namespace.
      const clusterWide = await options.checker.mayPerform(identity, VISIBILITY_PROBE)
      const all = [...(await options.listNamespaces())].sort()

      if (clusterWide.verdict === 'yes') {
        return {
          namespaces: all,
          unknown: [],
          clusterWide: true,
          total: all.length,
          truncated: false,
          source: 'rbac'
        }
      }

      const preferred = new Set(resolveOptions.preferred ?? [])
      const ordered = [
        ...all.filter(name => preferred.has(name)),
        ...all.filter(name => !preferred.has(name))
      ]
      const candidates = ordered.slice(0, maxNamespaces)
      const judgements = await mapWithConcurrency(candidates, concurrency, namespace =>
        options.checker.mayPerform(identity, { ...VISIBILITY_PROBE, namespace })
      )
      const namespaces: string[] = []
      const unknown: string[] = []

      judgements.forEach((judgement, index) => {
        if (judgement.verdict === 'yes') namespaces.push(candidates[index])
        else if (judgement.verdict === 'unknown') unknown.push(candidates[index])
      })

      return {
        namespaces: namespaces.sort(),
        unknown: unknown.sort(),
        clusterWide: false,
        total: all.length,
        truncated: all.length > candidates.length,
        source: 'rbac'
      }
    }
  }
}
