import type { Fact, Unknown } from '../../domain/provisioning/types.js'
import { KubernetesApiError } from '../observability-kubernetes.js'

// The ClusterRole and the image roll out independently, and half these APIs
// are CRDs that may not be installed. So a 403 or 404 must degrade one fact,
// never fail the answer, and the degradation has to be visible: an unreadable
// fact silently becoming a pass is how a planner lies to a beginner.
export async function optional<T>(source: string, load: () => Promise<T>): Promise<Fact<T>> {
  try {
    return { known: true, value: await load() }
  } catch (error) {
    if (error instanceof KubernetesApiError && (error.status === 403 || error.status === 404)) {
      return error.status === 403 ? rbacDenied(source) : notServed(source)
    }

    throw error
  }
}

export function rbacDenied(source: string): Unknown {
  return {
    known: false,
    reason: 'rbac',
    detail:
      `Not authorized to read ${source} (403). The driftmower-mcp ServiceAccount needs get/list on ${source}; ` +
      'add the rule to chart/templates/observability-rbac.yaml and redeploy.'
  }
}

export function notServed(source: string): Unknown {
  return {
    known: false,
    reason: 'absent',
    detail: `This cluster does not serve ${source}, so it could not be checked.`
  }
}

export function valueOr<T>(fact: Fact<T>, fallback: T): T {
  return fact.known ? fact.value : fallback
}
