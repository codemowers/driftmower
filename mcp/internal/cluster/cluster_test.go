package cluster

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func ptr(s string) *string { return &s }

func kubelogin(hosts ...string) *networkingv1.Ingress {
	ing := &networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Namespace: "default", Name: "kubelogin"}}
	for _, h := range hosts {
		ing.Spec.Rules = append(ing.Spec.Rules, networkingv1.IngressRule{Host: h})
	}

	return ing
}

func TestDiscover(t *testing.T) {
	fallback := NewIdentity(ptr("configured"), nil, "http://127.0.0.1:3000")
	logger := slog.New(slog.DiscardHandler)
	discover := func(objects ...*networkingv1.Ingress) Identity {
		client := fake.NewClientset()
		for _, o := range objects {
			_ = client.Tracker().Add(o)
		}

		return Discover(context.Background(), client, fallback, "https://auth.example.com", logger)
	}

	got := discover(kubelogin("kube.Bravo.example.com", "kube.bravo.example.com"))
	if *got.ID != "bravo.example.com" || *got.APIURL != "https://kube.bravo.example.com" ||
		got.MCPServerName != "driftmower-bravo-example-com" || got.Authentication != AuthenticationPassmowerOIDC ||
		got.OIDCIssuerURL != "https://auth.example.com" {
		t.Errorf("discovered = %+v", got)
	}

	for name, ing := range map[string]*networkingv1.Ingress{
		"ambiguous": kubelogin("a.example.com", "b.example.com"),
		"no host":   kubelogin(),
		"invalid":   kubelogin("bad_host.example.com"),
	} {
		if got := discover(ing); *got.ID != "configured" {
			t.Errorf("%s: identity = %+v", name, got)
		}
	}
	if got := discover(); *got.ID != "configured" {
		t.Errorf("absent ingress: identity = %+v", got)
	}
}

func TestInstructions(t *testing.T) {
	unset := Instructions(NewIdentity(nil, nil, "http://127.0.0.1:3000"))
	if !strings.HasPrefix(unset, "This MCP connection identifies cluster null; its external Kubernetes API URL is null.") ||
		!strings.Contains(unset, "context named <cluster>/<namespace>") || strings.Contains(unset, "oidc-login") {
		t.Errorf("unset instructions = %q", unset)
	}

	id := NewIdentity(ptr("bravo.example.com"), ptr("https://kube.bravo.example.com"), "")
	id.Authentication = AuthenticationPassmowerOIDC
	got := Instructions(id)
	for _, want := range []string{
		`identifies cluster "bravo.example.com"; its external Kubernetes API URL is "https://kube.bravo.example.com".`,
		"context named bravo.example.com/<namespace>",
		"--oidc-issuer-url=<confirmed OIDC issuer URL>",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("instructions lack %q", want)
		}
	}
}
