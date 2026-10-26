package provisioning

import (
	"slices"
	"strings"
	"testing"
)

// A real sandbox id: the hash prefix is assigned at creation.
var sandboxRule = HostRuleFor("ee-lte-1.codemowers.io", "a1b2c3-demo", "sandbox-ingress-guard", "", false, nil)

func TestHostRuleFor(t *testing.T) {
	if sandboxRule.ExactHost != "a1b2c3-demo.ee-lte-1.codemowers.io" || sandboxRule.LabelledPattern != "a1b2c3-demo-<label>.ee-lte-1.codemowers.io" {
		t.Errorf("rule = %+v", sandboxRule)
	}
}

func TestHostIsAllowedTenantPrefixed(t *testing.T) {
	cases := map[string]bool{
		"a1b2c3-demo.ee-lte-1.codemowers.io":      true,
		"a1b2c3-demo-api.ee-lte-1.codemowers.io":  true,
		"a1b2c3-demo-prom.ee-lte-1.codemowers.io": true,
		"myapp.ee-lte-1.codemowers.io":            false,
		"z9y8x7-other.ee-lte-1.codemowers.io":     false,
		"driftmower-ui.ee-lte-1.codemowers.io":    false,
		"*.ee-lte-1.codemowers.io":                false,
		// The middle segment may contain no ".".
		"a1b2c3-demo-foo.bar.ee-lte-1.codemowers.io": false,
		"a1b2c3-demo-.ee-lte-1.codemowers.io":        false,
		"a1b2c3-demo.ee-west-1.codemowers.io":        false,
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
	rule := HostRuleFor("aws-us-west-2-bravo.codemowers.io", "a1b2c3-demo", "sandbox-ingress-guard", "sb-a1b2c3-demo", true, []string{"acme.com"})
	if rule.ExactHost != "sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io" ||
		rule.LabelledPattern != "<label>.sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io" {
		t.Errorf("rule = %+v", rule)
	}
	for _, host := range []string{
		"sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io",
		"gitea.sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io",
		"a.b.sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io",
		"a1b2c3-demo-api.aws-us-west-2-bravo.codemowers.io",
		"acme.com",
		"www.acme.com",
	} {
		if !HostIsAllowed(host, rule) {
			t.Errorf("%s rejected", host)
		}
	}
	for _, host := range []string{
		"evil.sb-z9y8x7-other.aws-us-west-2-bravo.codemowers.io",
		"xsb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io",
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
		{map[string]string{"ingressDomainSuffix": "ee-lte-1.codemowers.io"}, "ee-lte-1.codemowers.io"},
		{map[string]string{"ingressDomainSuffix": ".ee-lte-1.codemowers.io"}, "ee-lte-1.codemowers.io"},
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
