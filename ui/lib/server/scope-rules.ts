// PURE. The tenancy decision itself, with no imports, so it can be tested
// directly -- sandbox-scope-filter.ts is the thin adapter that fetches a scope
// and turns a verdict into a Response.

export type ScopeState = "ok" | "not-configured" | "unreachable" | "unauthenticated"
export type ScopeLike = { state: ScopeState; admin?: boolean; namespaces?: string[] }

export type WriteVerdict = { allow: true } | { allow: false; status: 403 | 503; reason: string }

// READ path. null means "do not narrow".
export function namespaceAllowList(scope: ScopeLike): Set<string> | null {
  if (scope.state !== "ok" || scope.admin) return null
  return new Set(scope.namespaces ?? [])
}

// WRITE path. The three non-ok states are not equivalent, and collapsing them is
// what made this fail open:
//
//   not-configured  No tenancy control plane is deployed here and never was, so
//                   the cluster is single-tenant by construction (ee-lte-1 and
//                   ee-west-1 are exactly this). Allowing is the intended
//                   answer, not a degraded one.
//   unreachable     A control plane exists but did not answer. We do not know
//                   what this caller owns, so we must not let them write. The
//                   scope cache holds failures for a while, so answering
//                   "allowed" here would outlast the outage.
//   unauthenticated No usable token. The middleware rejects these before a route
//                   runs, so this is belt and braces.
export function writeVerdict(scope: ScopeLike, namespace: string): WriteVerdict {
  if (scope.state === "unreachable" || scope.state === "unauthenticated") {
    return {
      allow: false,
      status: 503,
      reason: "tenancy could not be determined, so this change was not attempted",
    }
  }

  const permitted = namespaceAllowList(scope)
  if (permitted && !permitted.has(namespace)) {
    return { allow: false, status: 403, reason: `namespace ${namespace} is out of scope` }
  }

  return { allow: true }
}
