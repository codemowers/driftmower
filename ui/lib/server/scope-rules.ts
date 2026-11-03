export type ScopeState = "ok" | "not-configured" | "unreachable" | "no-session" | "rejected"
export type ScopeLike = { state: ScopeState; admin?: boolean; namespaces?: string[] }

export type Denial = { allow: false; status: 401 | 403 | 503; reason: string }
export type ReadVerdict = { allow: true; namespaces: Set<string> | null } | Denial
export type WriteVerdict = { allow: true } | Denial

function denialFor(state: ScopeState): Denial | null {
  switch (state) {
    case "no-session":
      return { allow: false, status: 401, reason: "not authenticated" }
    case "rejected":
      return { allow: false, status: 403, reason: "platform-manager did not accept your sign-in, sign out and in again" }
    case "unreachable":
      return { allow: false, status: 503, reason: "tenancy could not be determined" }
    default:
      return null
  }
}

export function readVerdict(scope: ScopeLike): ReadVerdict {
  const denied = denialFor(scope.state)
  if (denied) return denied
  if (scope.state !== "ok" || scope.admin) return { allow: true, namespaces: null }
  return { allow: true, namespaces: new Set(scope.namespaces ?? []) }
}

export function writeVerdict(scope: ScopeLike, namespace: string): WriteVerdict {
  const verdict = readVerdict(scope)
  if (!verdict.allow) return { ...verdict, reason: `${verdict.reason}, so this change was not attempted` }
  if (verdict.namespaces && !verdict.namespaces.has(namespace)) {
    return { allow: false, status: 403, reason: `namespace ${namespace} is out of scope` }
  }
  return { allow: true }
}

export function seesClusterWideViews(scope: ScopeLike): boolean {
  const verdict = readVerdict(scope)
  return verdict.allow && verdict.namespaces === null
}
