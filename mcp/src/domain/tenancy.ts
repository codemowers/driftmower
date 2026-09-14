// The namespaces a caller may see results for.
//
// `null` means unrestricted, which is the stdio case (a local process reading a
// local database copy) and the unauthenticated-HTTP case. An array — including
// an empty one — means results must be confined to it.
//
// The empty array is deliberately not collapsed into `null`. A caller entitled
// to no namespaces must see nothing, not everything.
export type NamespaceScope = string[] | null

// Why the scope is what it is. This exists because the three cases need three
// different sentences: an unrestricted caller needs no note, a caller with an
// empty claim has a tenancy answer, and a caller whose token carries no claim
// at all has a *configuration* problem with a specific fix.
export type ScopeSource = 'unrestricted' | 'claim' | 'claim-missing'

export interface ResolvedScope {
  scope: NamespaceScope
  source: ScopeSource
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

  if (resolved.scope.length === 0) {
    return {
      scoped: true,
      namespaces: [],
      note:
        'Your access token grants access to no namespaces, so no results can be returned. ' +
        'This is an authorization limit, not an empty cluster.'
    }
  }

  return {
    scoped: true,
    namespaces: [...resolved.scope],
    note:
      matchCount === 0
        ? `No results within the namespaces you may access (${resolved.scope.join(', ')}). ` +
          'Matching workloads may exist in namespaces outside your access.'
        : `Results are limited to the namespaces you may access: ${resolved.scope.join(', ')}.`
  }
}
