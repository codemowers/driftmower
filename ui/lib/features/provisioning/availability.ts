// PURE. Turning "is the CRD served" plus "is the controller running" into the
// four states that actually happen — including the two silent ones, where an
// apply succeeds and then nothing ever acts on the object.

import type { Availability } from "./types"

export type OperatorHealth = {
  // Prefix-matched, because Helm prepends the release name to the Deployment.
  deployment: string
  namespace: string
  readyReplicas: number
  desiredReplicas: number
  version: string | null
  watchedNamespaces: string[] | "all"
}

export function availabilityOf(
  servesKind: boolean,
  operator: OperatorHealth | null,
  installHref: string | null,
): Availability {
  if (!servesKind) {
    // Nothing on the cluster understands the kind. An apply fails outright,
    // which is at least a loud failure.
    return { state: "not-installed", installHref }
  }

  if (!operator) {
    // The CRDs are there but no controller is. This is the quiet one: the apply
    // succeeds and the object sits untouched forever.
    return {
      state: "crds-only",
      reason:
        "The custom resources exist but no controller is running. `kubectl apply` would succeed " +
        "and the object would sit there with nothing acting on it.",
    }
  }

  if (operator.readyReplicas < 1) {
    return {
      state: "degraded",
      version: operator.version,
      reason:
        `The controller Deployment ${operator.namespace}/${operator.deployment} reports ` +
        `${operator.readyReplicas}/${operator.desiredReplicas} pods ready. Manifests would apply ` +
        `but nothing would act on them.`,
    }
  }

  return { state: "ready", version: operator.version, watchedNamespaces: operator.watchedNamespaces }
}

export function isOfferable(availability: Availability): boolean {
  return availability.state === "ready" || availability.state === "degraded"
}
