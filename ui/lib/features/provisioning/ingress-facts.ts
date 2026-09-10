// PURE. What hostname a user may actually claim, which on these clusters is
// not a convention but an admission rule — and one they cannot guess, because
// a sandbox id begins with a creation-time random hash (`<hash6>-<name>`).
//
// The rule, from platform-manager/deploy/sandbox-guard.yaml: a host must be
// exactly `<sandbox-id>.<suffix>` or `<sandbox-id>-<label>.<suffix>`, with no
// further dots in the label. Wildcards, catch-all defaultBackends and host-less
// rules are rejected, and Traefik IngressRoute is denied outright.

export type IngressHostRule = {
  // From the guard's parameter ConfigMap, e.g. "ee-lte-1.codemowers.io".
  domainSuffix: string
  sandboxId: string
  // The two hostnames the guard accepts, spelled out.
  exactHost: string
  labelledPattern: string
  enforcedBy: string | null
}

export function hostRuleFor(
  domainSuffix: string,
  sandboxId: string,
  enforcedBy: string | null,
): IngressHostRule {
  return {
    domainSuffix,
    sandboxId,
    exactHost: `${sandboxId}.${domainSuffix}`,
    labelledPattern: `${sandboxId}-<label>.${domainSuffix}`,
    enforcedBy,
  }
}

// Mirrors the guard's CEL so the UI can reject a host before the apiserver
// does. Kept deliberately close to the original expression: exact match, or
// prefix `<id>-` plus the suffix, with the middle segment containing no dot.
export function hostIsAllowed(host: string, rule: IngressHostRule): boolean {
  if (host.startsWith("*")) return false

  const suffix = `.${rule.domainSuffix}`
  if (host === rule.exactHost) return true
  if (!host.startsWith(`${rule.sandboxId}-`)) return false
  if (!host.endsWith(suffix)) return false

  const middle = host.slice(rule.sandboxId.length + 1, host.length - suffix.length)
  return middle.length > 0 && !middle.includes(".")
}

export function hostRejectionReason(host: string, rule: IngressHostRule): string | null {
  if (hostIsAllowed(host, rule)) return null
  if (host.startsWith("*")) {
    return "Wildcard hosts are rejected: the ingress controller is shared, so a wildcard would claim other tenants' hostnames too."
  }
  return (
    `Hosts here must be ${rule.exactHost} or ${rule.labelledPattern} — anchored on your sandbox id, ` +
    "because the ingress controller is shared and the prefix is what stops one tenant claiming another's traffic."
  )
}

// The guard reads its suffix from a ConfigMap it names via paramRef. Reading
// the key rather than inferring the domain from existing Ingresses matters:
// inference would happily return the platform's own domain, which no sandbox
// may claim.
export const INGRESS_SUFFIX_KEY = "ingressDomainSuffix"

export function suffixFromParams(data: Record<string, string> | undefined): string | null {
  const value = data?.[INGRESS_SUFFIX_KEY]?.trim()
  return value ? value.replace(/^\.+/, "") : null
}

export type IngressClassFact = { name: string; controller: string; isDefault: boolean }

export type RawIngressClass = {
  metadata?: { name?: string; annotations?: Record<string, string> }
  spec?: { controller?: string }
}

const DEFAULT_CLASS_ANNOTATION = "ingressclass.kubernetes.io/is-default-class"

export function toIngressClassFact(raw: RawIngressClass): IngressClassFact | null {
  const name = raw.metadata?.name
  if (!name) return null
  return {
    name,
    controller: raw.spec?.controller ?? "(unknown)",
    isDefault: raw.metadata?.annotations?.[DEFAULT_CLASS_ANNOTATION] === "true",
  }
}

// TLS on these clusters comes from cert-manager plus a ClusterIssuer, so a user
// needs the issuer name for their Certificate — or to know that a shared
// wildcard already terminates TLS and they need nothing.
export type TlsFact = {
  clusterIssuers: string[]
  // True when some existing Ingress on this suffix already serves TLS without
  // naming a per-host secret, i.e. a shared wildcard is doing the work.
  sharedWildcard: boolean
  advice: string
}

export function tlsAdvice(clusterIssuers: string[], sharedWildcard: boolean): string {
  if (sharedWildcard) {
    return "A shared wildcard certificate already terminates TLS for this domain, so your Ingress needs no tls block of its own."
  }
  if (clusterIssuers.length > 0) {
    return `Request a certificate from the ${clusterIssuers[0]} ClusterIssuer and name its secret in your Ingress tls block.`
  }
  return "No ClusterIssuer was found, so TLS is not automatic here — ask the platform team how certificates are issued."
}
