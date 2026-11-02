import type { ObservabilityKubernetes } from '../clients/observability-kubernetes.js'

// A once-at-startup probe of the authorizer path this server depends on.
//
// It cannot detect a wrong username mapping: `system:basic-user` grants every
// authenticated principal the right to create SelfSubjectAccessReviews, so the
// review below is allowed for any username string. What it does establish is
// that the service account may create SubjectAccessReviews and that the
// cluster's authorizer answers them; when that is false, every RBAC-derived
// answer will be `unknown` and the operator should hear it at startup rather
// than from a confused agent.
export interface IdentityDiagnostics {
  sarUsable: boolean
  warning: string | null
}

export async function checkAuthorizer(
  allowed: ObservabilityKubernetes['allowed'],
  usernamePrefix: string
): Promise<IdentityDiagnostics> {
  try {
    const answer = await allowed(
      { user: `${usernamePrefix}driftmower-mcp-selfcheck`, groups: ['system:authenticated'] },
      { group: 'authorization.k8s.io', resource: 'selfsubjectaccessreviews', verb: 'create' }
    )

    return answer
      ? { sarUsable: true, warning: null }
      : {
          sarUsable: true,
          warning:
            'The cluster does not grant system:basic-user to system:authenticated; group-based access reviews may under-report'
        }
  } catch (error) {
    return {
      sarUsable: false,
      warning:
        'SubjectAccessReview is unavailable to the driftmower-mcp service account; RBAC-derived scope and ' +
        `access verdicts will report unknown (${error instanceof Error ? error.message : String(error)})`
    }
  }
}
