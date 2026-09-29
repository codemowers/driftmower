// The namespaces a caller may see results for.
//
// `null` means unrestricted, which is the stdio case (a local process reading a
// local database copy) and the unauthenticated-HTTP case. An array — including
// an empty one — means results must be confined to it.
//
// The empty array is deliberately not collapsed into `null`. A caller entitled
// to no namespaces must see nothing, not everything.
export type NamespaceScope = string[] | null

// Why the scope is what it is. Each source needs its own sentence: an
// unrestricted caller needs no note, a caller with an empty claim has a
// tenancy answer, a caller whose token carries no claim at all has a
// *configuration* problem with a specific fix, and a caller whose RBAC could
// not be evaluated has an *authorizer* problem that is nobody's tenancy answer.
export type ScopeSource =
  | 'unrestricted'
  | 'claim'
  | 'claim-missing'
  // Decided by the cluster authorizer (SubjectAccessReview per namespace).
  | 'rbac'
  // The authorizer answered, and the answer was: nowhere.
  | 'rbac-empty'
  // The authorizer could not be asked, or could not answer.
  | 'rbac-inconclusive'
  // Claim and RBAC both contributed.
  | 'union'

export interface ResolvedScope {
  scope: NamespaceScope
  source: ScopeSource
  detail?: ScopeDetail
}

export interface ScopeDetail {
  // The mapped Kubernetes identity the reviews were sent as, for prose.
  identity?: string
  claim?: string[]
  rbac?: string[]
  clusterWide?: boolean
  truncated?: boolean
  // Namespaces the authorizer could not evaluate.
  unknown?: number
  rbacError?: string
}

export type ScopePolicy = 'claim' | 'rbac' | 'union'

export interface RbacScopeInput {
  namespaces: string[]
  unknown: string[]
  clusterWide: boolean
  truncated: boolean
}

// Combines the token claim and the authorizer's answer under a policy.
//
// `union` is the default and is deliberately permissive in one direction only:
// an absent claim contributes nothing, and an unanswerable authorizer
// contributes nothing, so a caller ends up with the union of whatever each
// source could actually vouch for. Neither source can *remove* a namespace the
// other granted; both are grants, and the cluster still enforces every read.
export function mergeScopes(
  claim: string[] | undefined,
  rbac: RbacScopeInput | { error: string },
  policy: ScopePolicy,
  identity?: string
): ResolvedScope {
  if (policy === 'claim') return scopeFromClaim(claim)

  const rbacFailed = 'error' in rbac
  const detail: ScopeDetail = {
    identity,
    claim,
    ...(rbacFailed
      ? { rbacError: rbac.error }
      : {
          rbac: rbac.namespaces,
          clusterWide: rbac.clusterWide,
          truncated: rbac.truncated,
          unknown: rbac.unknown.length
        })
  }

  if (!rbacFailed && rbac.clusterWide) return { scope: null, source: 'rbac', detail }

  const fromClaim = policy === 'union' ? (claim ?? []) : []
  const fromRbac = rbacFailed ? [] : rbac.namespaces
  const scope = [...new Set([...fromClaim, ...fromRbac])].sort()

  if (rbacFailed) return { scope, source: 'rbac-inconclusive', detail }

  if (scope.length === 0) return { scope, source: 'rbac-empty', detail }

  return { scope, source: fromClaim.length > 0 && fromRbac.length > 0 ? 'union' : 'rbac', detail }
}

export const UNRESTRICTED_SCOPE: ResolvedScope = { scope: null, source: 'unrestricted' }

// Projects a verified token's namespaces claim onto a scope.
//
// A token with no claim resolves to the *empty* scope, not the unrestricted
// one. Failing open here would mean that dropping the `namespaces` scope from
// the OIDC client — a plausible misconfiguration — silently hands every caller
// the whole fleet. The note tells the caller exactly how to fix it.
export function scopeFromClaim(namespaces: string[] | undefined): ResolvedScope {
  if (namespaces === undefined) {
    return { scope: [], source: 'claim-missing' }
  }

  return { scope: namespaces, source: 'claim' }
}

// Handed back with every scoped result. An agent that cannot tell "there is
// nothing behind this" from "you are not allowed to see it" will confidently
// report the wrong one to the user, so the distinction is part of the payload
// rather than something the caller has to infer from an empty list.
export interface ScopeNotice {
  scoped: boolean
  namespaces: string[] | null
  note: string | null
}

export function describeScope(resolved: ResolvedScope, matchCount: number): ScopeNotice {
  if (resolved.source === 'unrestricted' || resolved.scope === null) {
    return { scoped: false, namespaces: null, note: null }
  }

  if (resolved.source === 'claim-missing') {
    return {
      scoped: true,
      namespaces: [],
      note:
        'Your access token carries no namespaces claim, so no results can be returned. ' +
        'Request the `namespaces` scope when obtaining the token; this is a token problem, not an empty cluster.'
    }
  }

  if (resolved.source === 'rbac-inconclusive') {
    const fallback =
      resolved.scope.length > 0
        ? ` Results are limited to the ${resolved.scope.length} namespace(s) your token claim names: ${resolved.scope.join(', ')}.`
        : ' No results can be returned.'

    return {
      scoped: true,
      namespaces: [...resolved.scope],
      note:
        `Kubernetes could not evaluate your access${resolved.detail?.identity ? ` as ${resolved.detail.identity}` : ''}: ` +
        `${resolved.detail?.rbacError ?? 'the access review failed'}.${fallback} ` +
        'This is an authorizer problem, not an empty cluster.'
    }
  }

  if (resolved.source === 'rbac-empty') {
    return {
      scoped: true,
      namespaces: [],
      note:
        `Kubernetes RBAC grants ${resolved.detail?.identity ?? 'your identity'} list-pods access in no namespace` +
        (resolved.detail?.claim?.length ? ', and none of the namespaces your token claim names' : '') +
        ', so no results can be returned. If that is unexpected, check KUBERNETES_USERNAME_CLAIM and ' +
        'KUBERNETES_USERNAME_PREFIX against the apiserver OIDC mapping. This is an authorization limit, not an empty cluster.'
    }
  }

  if (resolved.scope.length === 0) {
    return {
      scoped: true,
      namespaces: [],
      note:
        'Your access token grants access to no namespaces, so no results can be returned. ' +
        'This is an authorization limit, not an empty cluster.'
    }
  }

  const caveats: string[] = []

  if (resolved.detail?.unknown)
    caveats.push(
      `Access to ${resolved.detail.unknown} further namespace(s) could not be evaluated by the cluster authorizer; they are excluded, not denied.`
    )

  if (resolved.detail?.truncated)
    caveats.push(
      'The cluster has more namespaces than the access sweep checks; raise MCP_SCOPE_MAX_NAMESPACES if results seem incomplete.'
    )

  const suffix = caveats.length > 0 ? ` ${caveats.join(' ')}` : ''

  return {
    scoped: true,
    namespaces: [...resolved.scope],
    note:
      (matchCount === 0
        ? `No results within the namespaces you may access (${resolved.scope.join(', ')}). ` +
          'Matching workloads may exist in namespaces outside your access.'
        : `Results are limited to the namespaces you may access: ${resolved.scope.join(', ')}.`) + suffix
  }
}
