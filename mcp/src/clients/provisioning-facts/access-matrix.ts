import {
  resourceKey,
  VERBS,
  type AccessMatrix,
  type Verb,
  type Verdict
} from '../../domain/provisioning/access-facts.js'
import type { ApiSurface } from '../../domain/provisioning/api-surface.js'
import type { AccessChecker } from '../access-check.js'
import { mapWithConcurrency } from '../concurrency.js'
import type { KubernetesIdentity } from '../observability-kubernetes.js'

// One SubjectAccessReview per namespaced resource type and verb, as the
// verified caller. Deliberately a plain loop with no shortcuts: every cell is
// the authorizer's own answer, and the cache underneath `allowed()` is what
// makes a repeat call free. Subresources and `proxy` are left to check_access.
export interface AccessMatrixBuilder {
  build(identity: KubernetesIdentity, namespace: string): Promise<AccessMatrix>
  // How many reviews one cold build costs, for prose and metrics.
  probeCount(): Promise<number>
}

export function createAccessMatrixBuilder(options: {
  surface: () => Promise<ApiSurface>
  checker: AccessChecker
  concurrency?: number
}): AccessMatrixBuilder {
  const concurrency = options.concurrency ?? 16

  async function resources(): Promise<{ group: string; resource: string }[]> {
    const surface = await options.surface()
    const seen = new Map<string, { group: string; resource: string }>()

    for (const served of surface.byKind.values()) {
      if (!served.namespaced) continue

      const key = resourceKey(served.group, served.plural)

      if (!seen.has(key)) seen.set(key, { group: served.group, resource: served.plural })
    }

    return [...seen.values()].sort((a, b) =>
      resourceKey(a.group, a.resource).localeCompare(resourceKey(b.group, b.resource))
    )
  }

  return {
    async probeCount() {
      return (await resources()).length * VERBS.length
    },
    async build(identity, namespace) {
      const targets = await resources()
      const probes = targets.flatMap(target => VERBS.map(verb => ({ ...target, verb })))
      const judgements = await mapWithConcurrency(probes, concurrency, probe =>
        options.checker.mayPerform(identity, {
          namespace,
          group: probe.group,
          resource: probe.resource,
          verb: probe.verb
        })
      )
      const matrix: AccessMatrix = {}

      probes.forEach((probe, index) => {
        const key = resourceKey(probe.group, probe.resource)
        const row = (matrix[key] ??= Object.fromEntries(VERBS.map(verb => [verb, 'unknown'])) as Record<
          Verb,
          Verdict
        >)

        row[probe.verb] = judgements[index].verdict
      })

      return matrix
    }
  }
}
