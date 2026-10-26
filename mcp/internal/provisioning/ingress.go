package provisioning

import (
	"strings"
)

// What hostname a user may claim when an admission guard confines hosts. Two
// shapes exist, told apart by the guard's own CEL rather than assumed:
//
//   - namespace-anchored: `<namespace>.<suffix>` or `<label>.<namespace>.<suffix>`;
//   - tenant-prefixed: `<tenant-id>.<suffix>` or `<tenant-id>-<label>.<suffix>`,
//     with no further dots in the label.
//
// A guard that reads a namespace annotation of verified custom domains also
// admits those domains and every name under them.

type IngressHostRule struct {
	DomainSuffix       string
	TenantID           string
	Namespace          string
	AnchorsOnNamespace bool
	ExactHost          string
	LabelledPattern    string
	CustomDomains      []string
	EnforcedBy         string
}

func HostRuleFor(domainSuffix, tenantID, enforcedBy, namespace string, anchorsOnNamespace bool, customDomains []string) IngressHostRule {
	anchored := anchorsOnNamespace && namespace != ""
	r := IngressHostRule{
		DomainSuffix:       domainSuffix,
		TenantID:           tenantID,
		Namespace:          namespace,
		AnchorsOnNamespace: anchored,
		CustomDomains:      orEmpty(customDomains),
		EnforcedBy:         enforcedBy,
	}
	if anchored {
		r.ExactHost = namespace + "." + domainSuffix
		r.LabelledPattern = "<label>." + namespace + "." + domainSuffix
	} else {
		r.ExactHost = tenantID + "." + domainSuffix
		r.LabelledPattern = tenantID + "-<label>." + domainSuffix
	}

	return r
}

// VerifiedDomainsAnnotation is where a guard reads verified custom domains:
// comma-separated, written by the platform, never by the namespace's users.
const VerifiedDomainsAnnotation = "codemowers.io/verified-domains"

func ParseCustomDomains(value string) []string {
	domains := []string{}
	for d := range strings.SplitSeq(value, ",") {
		if d = strings.ToLower(strings.TrimSpace(d)); d != "" {
			domains = append(domains, d)
		}
	}

	return domains
}

func underDomain(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}

// HostIsAllowed mirrors the guard's CEL so a host can be rejected before the
// API server does. The namespace-anchored guard still admits tenant-prefixed
// hosts so existing Ingresses stay editable.
func HostIsAllowed(host string, r IngressHostRule) bool {
	if strings.Contains(host, "*") {
		return false
	}
	for _, d := range r.CustomDomains {
		if underDomain(host, d) {
			return true
		}
	}
	suffix := "." + r.DomainSuffix
	if r.AnchorsOnNamespace {
		space := "." + r.Namespace + suffix
		if host == r.Namespace+suffix {
			return true
		}
		if strings.HasSuffix(host, space) && len(host) > len(space) && !strings.HasPrefix(host, ".") {
			return true
		}
	}
	if host == r.TenantID+suffix {
		return true
	}
	if !strings.HasPrefix(host, r.TenantID+"-") || !strings.HasSuffix(host, suffix) || len(host) < len(r.TenantID)+1+len(suffix) {
		return false
	}
	middle := host[len(r.TenantID)+1 : len(host)-len(suffix)]

	return middle != "" && !strings.Contains(middle, ".")
}

// IngressSuffixKey is the key in the guard's parameter ConfigMap carrying the
// domain suffix. Reading it, rather than inferring the domain from existing
// Ingresses, matters: inference would return the platform's own domain, which
// no tenant may claim.
const IngressSuffixKey = "ingressDomainSuffix"

func SuffixFromParams(data map[string]string) string {
	return strings.TrimLeft(strings.TrimSpace(data[IngressSuffixKey]), ".")
}

// IssuerFact is a ClusterIssuer: its readiness and, for ACME issuers, which
// challenge types its solvers offer. HTTP-01 issues one certificate per
// public hostname; only DNS-01 can issue wildcards.
type IssuerFact struct {
	Name string
	// Nil when the issuer reports no Ready condition.
	Ready *bool
	ACME  *ACMESolvers
}

type ACMESolvers struct {
	HTTP01 bool
	DNS01  bool
}

// TLSAdvice explains how public hostnames get certificates. A non-ACME issuer
// cannot certify a public name, so it is only mentioned for what it is.
func TLSAdvice(issuers []IssuerFact) string {
	var usable []IssuerFact
	for _, i := range issuers {
		if i.Ready == nil || *i.Ready {
			usable = append(usable, i)
		}
	}
	var http01, dns01 *IssuerFact
	for i := range usable {
		if http01 == nil && usable[i].ACME != nil && usable[i].ACME.HTTP01 {
			http01 = &usable[i]
		}
		if dns01 == nil && usable[i].ACME != nil && usable[i].ACME.DNS01 {
			dns01 = &usable[i]
		}
	}

	switch {
	case http01 != nil:
		advice := "Public hostnames get one certificate each from the " + http01.Name + " ClusterIssuer over ACME HTTP-01: " +
			"annotate the Ingress with `cert-manager.io/cluster-issuer: " + http01.Name + "` and list every host under " +
			"spec.tls with a secretName, or create a Certificate per host. Issuance needs the hostname to already resolve to " +
			"this cluster's ingress (for a custom domain, a CNAME to one of the namespace's own hostnames; a bare domain " +
			"needs the DNS provider's ALIAS/ANAME or CNAME flattening, not A records). "
		if dns01 != nil {
			return advice + "Wildcard certificates need DNS-01, which the " + dns01.Name + " ClusterIssuer offers."
		}

		return advice + "Wildcard certificates need DNS-01, which no ClusterIssuer here offers, so request each hostname separately."
	case dns01 != nil:
		return "Request certificates from the " + dns01.Name + " ClusterIssuer (ACME DNS-01) and name each secret in your Ingress tls block."
	case len(usable) > 0:
		names := make([]string, len(usable))
		for i, u := range usable {
			names[i] = u.Name
		}

		return "The ClusterIssuers here (" + strings.Join(names, ", ") + ") are not ACME issuers, so they cannot " +
			"certify public hostnames; ask the platform team how public TLS is provided."
	default:
		return "No ClusterIssuer was found, so TLS is not automatic here — ask the platform team how certificates are issued."
	}
}
