import {
  KubernetesApiError,
  type AccessAttributes,
  type KubernetesIdentity,
  type ObservabilityKubernetes
} from './observability-kubernetes.js'

// A three-valued answer to "may this caller do X". `unknown` is a first-class
// outcome, never collapsed into `no`: an agent must be able to tell "denied"
// from "could not be evaluated", because only one of them is fixed by asking
// for permission.
export type Verdict = 'yes' | 'no' | 'unknown'

export interface Judgement {
  verdict: Verdict
  // Null for `yes`; a sentence for `no` and `unknown`.
  reason: string | null
}

export interface AccessChecker {
  mayPerform(identity: KubernetesIdentity, attributes: AccessAttributes): Promise<Judgement>
}

const MAX_REASON_LENGTH = 200

export function describeAttributes(attributes: AccessAttributes): string {
  const resource = attributes.subresource
    ? `${attributes.resource}/${attributes.subresource}`
    : attributes.resource
  const qualified = `${resource}.${attributes.group || 'core'}`
  const name = attributes.name ? ` "${attributes.name}"` : ''
  const where = attributes.namespace ? ` in namespace ${attributes.namespace}` : ' cluster-wide'

  return `${attributes.verb} ${qualified}${name}${where}`
}

export function createAccessChecker(allowed: ObservabilityKubernetes['allowed']): AccessChecker {
  return {
    async mayPerform(identity, attributes) {
      try {
        const answer = await allowed(identity, attributes)

        return answer
          ? { verdict: 'yes', reason: null }
          : { verdict: 'no', reason: `Kubernetes RBAC denies ${describeAttributes(attributes)}` }
      } catch (error) {
        return { verdict: 'unknown', reason: inconclusiveReason(error) }
      }
    }
  }
}

// An HTTP 403 on the review itself means this server's service account may not
// create SubjectAccessReviews: a deployment problem, not a caller verdict.
function inconclusiveReason(error: unknown): string {
  if (error instanceof KubernetesApiError && error.status === 403) {
    return (
      'The driftmower-mcp service account may not create SubjectAccessReviews (HTTP 403); ' +
      'grant create on subjectaccessreviews.authorization.k8s.io'
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  // Authorizer errors can carry internal hostnames; log the full text, show a bounded excerpt.
  const excerpt = message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}…` : message

  return `The access review could not be evaluated: ${excerpt}`
}
