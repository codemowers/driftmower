import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z } from 'zod'
import {
  describeIdentity,
  kubernetesIdentityFor,
  type KubernetesIdentityMapping
} from '../../auth/kubernetes-identity.js'
import type { RbacScopeResolver } from '../../clients/rbac-scope.js'
import {
  mergeScopes,
  scopeFromClaim,
  UNRESTRICTED_SCOPE,
  type ResolvedScope,
  type ScopeNotice,
  type ScopePolicy
} from '../../domain/tenancy.js'

// The shape the SDK hands every tool handler as its second argument. Only the
// pieces this module reads are declared; the SDK's own type carries more.
export interface ToolCallContext {
  authInfo?: AuthInfo
}

export interface ScopeDependencies {
  policy: ScopePolicy
  resolver?: RbacScopeResolver
  identityMapping?: KubernetesIdentityMapping
  audit?: (line: string) => void
}

// The policy used when a tool is registered without scope dependencies:
// today's behaviour, the token claim alone.
export const CLAIM_ONLY: ScopeDependencies = { policy: 'claim' }

// Resolves the caller's tenancy from the verified token the transport attached.
//
// No `authInfo` means the transport did not authenticate this call, which
// happens on stdio and when MCP_AUTH_ENABLED is off. Both are local or
// in-cluster-only deployments where the operator has already decided the
// process is trusted, so the scope is unrestricted. Once a token is present
// the answer comes from the configured sources: the claim alone, the cluster
// authorizer alone, or (the default) the union of both. An absent claim under
// the claim-only policy resolves to no access rather than full access.
export async function resolveCallerScope(
  context: ToolCallContext | undefined,
  dependencies: ScopeDependencies = CLAIM_ONLY
): Promise<ResolvedScope> {
  const authInfo = context?.authInfo

  if (!authInfo) {
    return UNRESTRICTED_SCOPE
  }

  const claim = readNamespaces(authInfo)

  if (dependencies.policy === 'claim' || !dependencies.resolver || !dependencies.identityMapping) {
    return scopeFromClaim(claim)
  }

  const resolved = kubernetesIdentityFor(authInfo, dependencies.identityMapping)

  if (!resolved.ok) {
    return mergeScopes(claim, { error: resolved.detail }, dependencies.policy)
  }

  const identity = describeIdentity(resolved.identity)

  try {
    const rbac = await dependencies.resolver.resolve(resolved.identity, { preferred: claim })

    dependencies.audit?.(
      `[mcp] scope sub=${callerSubject(context)} user=${resolved.identity.user} namespaces=${rbac.namespaces.length} clusterWide=${rbac.clusterWide} unknown=${rbac.unknown.length} truncated=${rbac.truncated} policy=${dependencies.policy}`
    )

    return mergeScopes(claim, rbac, dependencies.policy, identity)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    dependencies.audit?.(
      `[mcp] scope sub=${callerSubject(context)} user=${resolved.identity.user} error=${message}`
    )

    return mergeScopes(claim, { error: message }, dependencies.policy, identity)
  }
}

export function callerSubject(context: ToolCallContext | undefined): string {
  const subject = context?.authInfo?.extra?.sub

  return typeof subject === 'string' ? subject : 'anonymous'
}

function readNamespaces(authInfo: AuthInfo): string[] | undefined {
  const namespaces = authInfo.extra?.namespaces

  if (!Array.isArray(namespaces)) {
    return undefined
  }

  return namespaces.filter((item): item is string => typeof item === 'string')
}

export const scopeNoticeSchema = z.object({
  scoped: z.boolean(),
  namespaces: z.array(z.string()).nullable(),
  note: z.string().nullable()
})

// The scope note is the difference between "nothing matched" and "nothing you
// may see". A text summary that drops it turns a withheld result into an
// apparently empty one, so every summary appends it when present.
export function scopeSuffix(scope: ScopeNotice): string {
  return scope.note ? ` ${scope.note}` : ''
}
