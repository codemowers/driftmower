// PURE. What hostname a user may actually claim when an admission guard
// confines hosts. Two shapes exist in the wild, told apart by the guard's own
// CEL rather than assumed:
//
// - namespace-anchored: `<namespace>.<suffix>` or `<label>.<namespace>.<suffix>`
//   (the cluster-wide `<service>.<namespace>.<region>.<domain>` convention);
// - tenant-prefixed: `<tenant-id>.<suffix>` or `<tenant-id>-<label>.<suffix>`,
//   with no further dots in the label (the older sandbox convention).
//
// A guard that reads a namespace annotation of verified custom domains also
// admits those domains and every name under them. Only reported when such a
// guard exists; a cluster without one gets no fabricated pattern.

export type IngressHostRule = {
  // From the guard's parameter ConfigMap, e.g. "ee-lte-1.codemowers.io".
  domainSuffix: string
  tenantId: string
  namespace: string
  anchorsOnNamespace: boolean
  // The two hostnames the guard accepts, spelled out.
  exactHost: string
  labelledPattern: string
  // Custom domains verified for this namespace, as the guard reads them.
  customDomains: string[]
  enforcedBy: string | null
}

export function hostRuleFor(
  domainSuffix: string,
  tenantId: string,
  enforcedBy: string | null,
  options: { namespace?: string; anchorsOnNamespace?: boolean; customDomains?: string[] } = {}
): IngressHostRule {
  const namespace = options.namespace ?? ''
  const anchored = Boolean(options.anchorsOnNamespace && namespace)

  return {
    domainSuffix,
    tenantId,
    namespace,
    anchorsOnNamespace: anchored,
    exactHost: anchored ? `${namespace}.${domainSuffix}` : `${tenantId}.${domainSuffix}`,
    labelledPattern: anchored ? `<label>.${namespace}.${domainSuffix}` : `${tenantId}-<label>.${domainSuffix}`,
    customDomains: options.customDomains ?? [],
    enforcedBy
  }
}

// The annotation a guard reads for verified custom domains: comma-separated,
// written by the platform, never by the namespace's users.
export const VERIFIED_DOMAINS_ANNOTATION = 'codemowers.io/verified-domains'

export function parseCustomDomains(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
}

function underDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

// Mirrors the guard's CEL so the UI can reject a host before the apiserver
// does. The namespace-anchored guard still admits tenant-prefixed hosts so
// existing Ingresses stay editable, so both shapes are checked there.
export function hostIsAllowed(host: string, rule: IngressHostRule): boolean {
  if (host.includes('*')) return false

  if (rule.customDomains.some(domain => underDomain(host, domain))) return true

  const suffix = `.${rule.domainSuffix}`

  if (rule.anchorsOnNamespace) {
    const space = `.${rule.namespace}${suffix}`

    if (host === `${rule.namespace}${suffix}`) return true

    if (host.endsWith(space) && host.length > space.length && !host.startsWith('.')) return true
  }

  if (host === `${rule.tenantId}${suffix}`) return true

  if (!host.startsWith(`${rule.tenantId}-`)) return false

  if (!host.endsWith(suffix)) return false

  const middle = host.slice(rule.tenantId.length + 1, host.length - suffix.length)

  return middle.length > 0 && !middle.includes('.')
}

export function hostRejectionReason(host: string, rule: IngressHostRule): string | null {
  if (hostIsAllowed(host, rule)) return null

  if (host.includes('*')) {
    return "Wildcard hosts are rejected: the ingress controller is shared, so a wildcard would claim other tenants' hostnames too."
  }

  const custom = rule.customDomains.length
    ? `, or a name under ${rule.customDomains.join(', ')}`
    : ''

  return rule.anchorsOnNamespace
    ? `Hosts here must be ${rule.exactHost} or ${rule.labelledPattern}${custom}: anchored on your namespace, ` +
        "because the ingress controller is shared and that anchor is what stops one tenant claiming another's traffic."
    : `Hosts here must be ${rule.exactHost} or ${rule.labelledPattern}${custom}: anchored on your tenant id, ` +
        "because the ingress controller is shared and the prefix is what stops one tenant claiming another's traffic."
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

// A ClusterIssuer as discovered: its name, readiness, and, for ACME issuers,
// which challenge types its solvers offer. That last part decides how
// certificates work: HTTP-01 issues one certificate per public hostname once
// the name resolves to the cluster; only DNS-01 can issue wildcards.
export type IssuerFact = {
  name: string
  ready: boolean | null
  acme: { http01: boolean; dns01: boolean } | null
}

// Advice for public hostnames. An ACME issuer is the one that can certify a
// public name; a non-ACME issuer (an internal CA, self-signed) cannot, so it is
// never offered for that, only mentioned for what it is.
export function tlsAdvice(issuers: IssuerFact[]): string {
  const usable = issuers.filter(issuer => issuer.ready !== false)
  const http01 = usable.find(issuer => issuer.acme?.http01)
  const dns01 = usable.find(issuer => issuer.acme?.dns01)

  if (http01) {
    return (
      `Public hostnames get one certificate each from the ${http01.name} ClusterIssuer over ACME HTTP-01: ` +
      `annotate the Ingress with \`cert-manager.io/cluster-issuer: ${http01.name}\` and list every host under ` +
      'spec.tls with a secretName, or create a Certificate per host. Issuance needs the hostname to already resolve to ' +
      'this cluster\'s ingress (for a custom domain, a CNAME to one of the namespace\'s own hostnames; a bare domain ' +
      'needs the DNS provider\'s ALIAS/ANAME or CNAME flattening, not A records). ' +
      (dns01
        ? `Wildcard certificates need DNS-01, which the ${dns01.name} ClusterIssuer offers.`
        : 'Wildcard certificates need DNS-01, which no ClusterIssuer here offers, so request each hostname separately.')
    )
  }

  if (dns01) {
    return `Request certificates from the ${dns01.name} ClusterIssuer (ACME DNS-01) and name each secret in your Ingress tls block.`
  }

  if (usable.length > 0) {
    return (
      `The ClusterIssuers here (${usable.map(issuer => issuer.name).join(', ')}) are not ACME issuers, so they cannot ` +
      'certify public hostnames; ask the platform team how public TLS is provided.'
    )
  }

  return 'No ClusterIssuer was found, so TLS is not automatic here — ask the platform team how certificates are issued.'
}
