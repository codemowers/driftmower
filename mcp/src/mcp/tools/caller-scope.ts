import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z } from 'zod'
import { scopeFromClaim, UNRESTRICTED_SCOPE, type ResolvedScope } from '../../domain/tenancy.js'

// The shape the SDK hands every tool handler as its second argument. Only the
// pieces this module reads are declared; the SDK's own type carries more.
export interface ToolCallContext {
  authInfo?: AuthInfo
}

// Resolves the caller's tenancy from the verified token the transport attached.
//
// No `authInfo` means the transport did not authenticate this call, which
// happens on stdio and when MCP_AUTH_ENABLED is off. Both are local or
// in-cluster-only deployments where the operator has already decided the
// process is trusted, so the scope is unrestricted. Once a token is present its
// claim is authoritative — including when the claim is absent, which
// `scopeFromClaim` resolves to no access rather than full access.
export function callerScope(context: ToolCallContext | undefined): ResolvedScope {
  const authInfo = context?.authInfo

  if (!authInfo) {
    return UNRESTRICTED_SCOPE
  }

  return scopeFromClaim(readNamespaces(authInfo))
}

// The caller's raw token, forwarded to driftmower-ui so its provisioning route
// decides tenancy against the same identity this server verified. `null` on an
// unauthenticated transport, where driftmower-ui applies its own session gate.
export function callerAccessToken(context: ToolCallContext | undefined): string | null {
  return context?.authInfo?.token ?? null
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
