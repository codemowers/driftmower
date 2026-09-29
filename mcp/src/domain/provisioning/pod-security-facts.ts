// PURE. Pod Security Admission, which is a built-in controller rather than a
// ValidatingAdmissionPolicy or a Kyverno rule — so nothing in the admission
// fact family sees it, and the page said nothing about the constraint most
// likely to stop a beginner's first pod.
//
// Every requirement below was confirmed by submitting pods to a live
// enforce=restricted namespace: a plain container is rejected, an explicit
// runAsUser: 0 is rejected, and a pod setting all four is accepted.

export type PodSecurityLevel = 'privileged' | 'baseline' | 'restricted'

export type PodSecurityFact = {
  enforce: PodSecurityLevel
  // What a pod must set to be admitted, in the API's own field names.
  requires: string[]
  // One sentence a beginner can act on.
  summary: string
}

const ENFORCE_LABEL = 'pod-security.kubernetes.io/enforce'

// Quoted from the apiserver's own denial in an enforce=restricted namespace, so
// the page says what the user will be told rather than a paraphrase of it.
const RESTRICTED_REQUIREMENTS = [
  'securityContext.runAsNonRoot=true',
  'securityContext.allowPrivilegeEscalation=false',
  'securityContext.capabilities.drop=["ALL"]',
  'securityContext.seccompProfile.type="RuntimeDefault"'
]

const BASELINE_SUMMARY =
  'Privileged containers, host networking and host paths are rejected, but running as root is allowed.'

const RESTRICTED_SUMMARY =
  'Containers cannot run as root here, and a pod that sets no securityContext at all is rejected outright — ' +
  'the four fields below are required, not defaults.'

export function podSecurityFor(labels: Record<string, string> | undefined): PodSecurityFact | null {
  const value = labels?.[ENFORCE_LABEL]?.trim()

  if (value !== 'privileged' && value !== 'baseline' && value !== 'restricted') return null

  if (value === 'privileged') {
    return {
      enforce: 'privileged',
      requires: [],
      summary: 'No pod security level is enforced in this namespace.'
    }
  }

  return {
    enforce: value,
    requires: value === 'restricted' ? RESTRICTED_REQUIREMENTS : [],
    summary: value === 'restricted' ? RESTRICTED_SUMMARY : BASELINE_SUMMARY
  }
}
