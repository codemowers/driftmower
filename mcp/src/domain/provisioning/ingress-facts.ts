// PURE. What hostname a user may actually claim when an admission guard
// enforces a tenant prefix: exactly `<tenant-id>.<suffix>` or
// `<tenant-id>-<label>.<suffix>`, with no further dots in the label. Only
// reported when such a guard exists; a cluster without one gets no fabricated
// pattern.

export type IngressHostRule = {
  // From the guard's parameter ConfigMap, e.g. "ee-lte-1.codemowers.io".
  domainSuffix: string
  tenantId: string
  // The two hostnames the guard accepts, spelled out.
  exactHost: string
  labelledPattern: string
  enforcedBy: string | null
}

export function hostRuleFor(
  domainSuffix: string,
  tenantId: string,
  enforcedBy: string | null
): IngressHostRule {
  return {
    domainSuffix,
    tenantId,
    exactHost: `${tenantId}.${domainSuffix}`,
    labelledPattern: `${tenantId}-<label>.${domainSuffix}`,
    enforcedBy
  }
}

// Mirrors the guard's CEL so the UI can reject a host before the apiserver
// does. Kept deliberately close to the original expression: exact match, or
// prefix `<id>-` plus the suffix, with the middle segment containing no dot.
export function hostIsAllowed(host: string, rule: IngressHostRule): boolean {
  if (host.startsWith('*')) return false

  const suffix = `.${rule.domainSuffix}`

  if (host === rule.exactHost) return true

  if (!host.startsWith(`${rule.tenantId}-`)) return false

  if (!host.endsWith(suffix)) return false

  const middle = host.slice(rule.tenantId.length + 1, host.length - suffix.length)

  return middle.length > 0 && !middle.includes('.')
}

export function hostRejectionReason(host: string, rule: IngressHostRule): string | null {
  if (hostIsAllowed(host, rule)) return null

  if (host.startsWith('*')) {
    return "Wildcard hosts are rejected: the ingress controller is shared, so a wildcard would claim other tenants' hostnames too."
  }

  return (
    `Hosts here must be ${rule.exactHost} or ${rule.labelledPattern} — anchored on your tenant id, ` +
    "because the ingress controller is shared and the prefix is what stops one tenant claiming another's traffic."
  )
}

// The guard reads its suffix from a ConfigMap it names via paramRef. Reading
// the key rather than inferring the domain from existing Ingresses matters:
// inference would happily return the platform's own domain, which no sandbox
// may claim.
export const INGRESS_SUFFIX_KEY = 'ingressDomainSuffix'

// Where the suffix came from, because the two sources do not carry the same
// authority. The guard's own parameter is what admission enforces; a value
// configured on this server is not verified against any policy.
export type SuffixSource = 'guard-params' | 'config'

export type DomainSuffix = { value: string; source: SuffixSource }

export function suffixFromParams(data: Record<string, string> | undefined): string | null {
  const value = data?.[INGRESS_SUFFIX_KEY]?.trim()

  return value ? value.replace(/^\.+/, '') : null
}

// With cert-manager present a user needs the issuer name for their
// Certificate; without it, TLS is whatever the platform does upstream.
export function tlsAdvice(clusterIssuers: string[]): string {
  if (clusterIssuers.length > 0) {
    return `Request a certificate from the ${clusterIssuers[0]} ClusterIssuer and name its secret in your Ingress tls block.`
  }

  return 'No ClusterIssuer was found, so TLS is not automatic here — ask the platform team how certificates are issued.'
}
