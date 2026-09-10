import "server-only"

import { KubeApiError } from "@/lib/server/k8s"
import type { Fact, Unknown } from "../types"

// The ClusterRole and the image roll out independently, and half these APIs are
// CRDs that may not be installed. So a 403 or 404 must degrade one fact, never
// fail a page — and the degradation has to be visible, because an unreadable
// fact silently becoming a pass is how a planner lies to a beginner.
export async function optional<T>(
  source: string,
  load: () => Promise<T>,
): Promise<Fact<T>> {
  try {
    return { known: true, value: await load() }
  } catch (e) {
    if (e instanceof KubeApiError && (e.status === 403 || e.status === 404)) {
      return e.status === 403 ? rbacDenied(source) : notServed(source)
    }
    throw e
  }
}

export function rbacDenied(source: string): Unknown {
  return {
    known: false,
    reason: "rbac",
    detail:
      `Not authorized to list ${source} (403). The driftmower-ui ServiceAccount needs ` +
      `get/list on ${source} — add a cluster-scoped RBAC rule (see k8s/rbac.yaml) and redeploy.`,
  }
}

export function notServed(source: string): Unknown {
  return {
    known: false,
    reason: "absent",
    detail: `This cluster does not serve ${source}, so it could not be checked.`,
  }
}

export function valueOr<T>(fact: Fact<T>, fallback: T): T {
  return fact.known ? fact.value : fallback
}
