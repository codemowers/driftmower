import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  describeIdentity,
  kubernetesIdentityFor,
  type KubernetesIdentityMapping
} from '../../auth/kubernetes-identity.js'
import type { RbacScopeResolver } from '../../clients/rbac-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export const accessibleNamespacesSchema = z.object({
  namespaces: z.array(z.string()),
  clusterWide: z.boolean(),
  unknown: z.array(z.string()),
  truncated: z.boolean(),
  identity: z.object({ user: z.string(), groups: z.array(z.string()) }),
  note: z.string().nullable()
})

export function registerAccessibleNamespacesTool(
  server: McpServer,
  resolver: RbacScopeResolver,
  mapping: KubernetesIdentityMapping
): void {
  server.registerTool(
    'list_accessible_namespaces',
    {
      title: 'List accessible namespaces',
      description:
        'Namespaces where the cluster authorizer lets the caller list pods, asked through SubjectAccessReview as the verified caller identity. Visibility only: being listed does not imply permission to create or change anything; ask per operation. Unknown entries could not be evaluated and are excluded, not denied.',
      inputSchema: {},
      outputSchema: accessibleNamespacesSchema,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      const resolved = kubernetesIdentityFor(context.authInfo, mapping)

      if (!resolved.ok)
        throw new Error(`Namespace discovery requires an authenticated caller: ${resolved.detail}`)

      const scope = await resolver.resolve(resolved.identity)
      const result = {
        namespaces: scope.namespaces,
        clusterWide: scope.clusterWide,
        unknown: scope.unknown,
        truncated: scope.truncated,
        identity: resolved.identity,
        note: scopeNote(scope, resolved.identity)
      }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}

function scopeNote(
  scope: Awaited<ReturnType<RbacScopeResolver['resolve']>>,
  identity: { user: string; groups: string[] }
): string | null {
  const notes: string[] = []

  if (scope.clusterWide)
    notes.push('The caller may list pods in every namespace, so all namespaces are listed.')

  if (scope.unknown.length > 0)
    notes.push(
      `Access to ${scope.unknown.length} namespace(s) could not be evaluated by the cluster authorizer; they are excluded, not denied.`
    )

  if (scope.truncated)
    notes.push(
      `The cluster has ${scope.total} namespaces and only a bounded set was checked; name namespaces explicitly or raise MCP_SCOPE_MAX_NAMESPACES.`
    )

  if (!scope.clusterWide && scope.namespaces.length === 0 && scope.unknown.length === 0)
    notes.push(
      `Kubernetes RBAC grants ${describeIdentity(identity)} list-pods access in no namespace. If that is unexpected, check KUBERNETES_USERNAME_CLAIM and KUBERNETES_USERNAME_PREFIX against the apiserver's OIDC mapping.`
    )

  return notes.length > 0 ? notes.join(' ') : null
}
