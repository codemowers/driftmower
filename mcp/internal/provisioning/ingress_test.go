package provisioning

import (
	"slices"
	"strings"
	"testing"
)

// A real sandbox id: the hash prefix is assigned at creation.
var sandboxRule = HostRuleFor("alpha.example.com", "a1b2c3-demo", "sandbox-ingress-guard", "", false, nil)

func TestHostRuleFor(t *testing.T) {
	if sandboxRule.ExactHost != "a1b2c3-demo.alpha.example.com" || sandboxRule.LabelledPattern != "a1b2c3-demo-<label>.alpha.example.com" {
		t.Errorf("rule = %+v", sandboxRule)
	}
}

func TestHostIsAllowedTenantPrefixed(t *testing.T) {
	cases := map[string]bool{
		"a1b2c3-demo.alpha.example.com":      true,
		"a1b2c3-demo-api.alpha.example.com":  true,
		"a1b2c3-demo-prom.alpha.example.com": true,
		"myapp.alpha.example.com":            false,
		"z9y8x7-other.alpha.example.com":     false,
		"driftmower-ui.alpha.example.com":    false,
		"*.alpha.example.com":                false,
		// The middle segment may contain no ".".
		"a1b2c3-demo-foo.bar.alpha.example.com": false,
		"a1b2c3-demo-.alpha.example.com":        false,
		"a1b2c3-demo.beta.example.com":          false,
	}
	for host, want := range cases {
		if got := HostIsAllowed(host, sandboxRule); got != want {
			t.Errorf("HostIsAllowed(%q) = %v", host, got)
		}
	}
}

// Each case was submitted to a real sandbox-ingress-guard with
// kubectl create --dry-run=server and the verdict recorded.
func TestHostIsAllowedMatchesGuard(t *testing.T) {
	rule := HostRuleFor("veebkolm.eu", "abc123-demo", "sandbox-ingress-guard", "", false, nil)
	observed := map[string]bool{
		"abc123-demo.veebkolm.eu":     true,
		"abc123-demo-api.veebkolm.eu": true,
		"myapp.veebkolm.eu":           false,
		"*.veebkolm.eu":               false,
		"abc123-demo-a.b.veebkolm.eu": false,
		"536389-mint.veebkolm.eu":     false,
		"abc123-demo.example.com":     false,
	}
	for host, want := range observed {
		if got := HostIsAllowed(host, rule); got != want {
			t.Errorf("HostIsAllowed(%q) = %v, guard decided %v", host, got, want)
		}
	}
}

func TestNamespaceAnchoredHosts(t *testing.T) {
	rule := HostRuleFor("bravo.example.com", "a1b2c3-demo", "sandbox-ingress-guard", "sb-a1b2c3-demo", true, []string{"acme.com"})
	if rule.ExactHost != "sb-a1b2c3-demo.bravo.example.com" ||
		rule.LabelledPattern != "<label>.sb-a1b2c3-demo.bravo.example.com" {
		t.Errorf("rule = %+v", rule)
	}
	for _, host := range []string{
		"sb-a1b2c3-demo.bravo.example.com",
		"gitea.sb-a1b2c3-demo.bravo.example.com",
		"a.b.sb-a1b2c3-demo.bravo.example.com",
		"a1b2c3-demo-api.bravo.example.com",
		"acme.com",
		"www.acme.com",
	} {
		if !HostIsAllowed(host, rule) {
			t.Errorf("%s rejected", host)
		}
	}
	for _, host := range []string{
		"evil.sb-z9y8x7-other.bravo.example.com",
		"xsb-a1b2c3-demo.bravo.example.com",
		"notacme.com",
		"victim.example.com",
		"*.acme.com",
	} {
		if HostIsAllowed(host, rule) {
			t.Errorf("%s allowed", host)
		}
	}
}

func TestParseCustomDomains(t *testing.T) {
	if got := ParseCustomDomains(" Acme.com, ,b.org "); !slices.Equal(got, []string{"acme.com", "b.org"}) {
		t.Errorf("got %v", got)
	}
	if got := ParseCustomDomains(""); got == nil || len(got) != 0 {
		t.Errorf("empty = %#v", got)
	}
}

func TestSuffixFromParams(t *testing.T) {
	cases := []struct {
		data map[string]string
		want string
	}{
		{map[string]string{"ingressDomainSuffix": "alpha.example.com"}, "alpha.example.com"},
		{map[string]string{"ingressDomainSuffix": ".alpha.example.com"}, "alpha.example.com"},
		{map[string]string{}, ""},
		{nil, ""},
		{map[string]string{"ingressDomainSuffix": "  "}, ""},
	}
	for _, tc := range cases {
		if got := SuffixFromParams(tc.data); got != tc.want {
			t.Errorf("SuffixFromParams(%v) = %q", tc.data, got)
		}
	}
}

func TestTLSAdvice(t *testing.T) {
	yes, no := true, false
	http01 := &ACMESolvers{HTTP01: true}

	if got := TLSAdvice([]IssuerFact{{Name: "letsencrypt", Ready: &yes, ACME: http01}}); !strings.Contains(got, "letsencrypt ClusterIssuer") {
		t.Errorf("one issuer = %q", got)
	}
	if got := TLSAdvice(nil); !strings.Contains(got, "not automatic") {
		t.Errorf("none = %q", got)
	}

	// bravo's real list: the internal CA sorts first.
	advice := TLSAdvice([]IssuerFact{
		{Name: "cluster-tls-issuer", Ready: &yes},
		{Name: "letsencrypt", Ready: &yes, ACME: http01},
		{Name: "selfsigned-issuer", Ready: &yes},
	})
	for _, want := range []string{
		"one certificate each from the letsencrypt ClusterIssuer over ACME HTTP-01",
		"cert-manager.io/cluster-issuer: letsencrypt",
		"no ClusterIssuer here offers",
		"ALIAS/ANAME or CNAME flattening",
	} {
		if !strings.Contains(advice, want) {
			t.Errorf("advice lacks %q", want)
		}
	}
	if strings.Contains(advice, "cluster-tls-issuer") {
		t.Error("advice names the internal CA")
	}

	if got := TLSAdvice([]IssuerFact{{Name: "letsencrypt", Ready: &yes, ACME: http01},
		{Name: "letsencrypt-dns", Ready: &yes, ACME: &ACMESolvers{DNS01: true}}}); !strings.Contains(got, "which the letsencrypt-dns ClusterIssuer offers") {
		t.Errorf("dns01 = %q", got)
	}
	if got := TLSAdvice([]IssuerFact{{Name: "letsencrypt", Ready: &no, ACME: http01}}); !strings.Contains(got, "not automatic") {
		t.Errorf("not ready = %q", got)
	}
	if got := TLSAdvice([]IssuerFact{{Name: "internal", Ready: &yes}}); !strings.Contains(got, "not ACME issuers") {
		t.Errorf("internal = %q", got)
	}
}
