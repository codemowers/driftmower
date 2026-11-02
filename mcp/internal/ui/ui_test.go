package ui

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
	"k8s.io/client-go/rest"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/facts"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower/mcp/internal/testutil/kubetest"
	"github.com/codemowers/driftmower/mcp/internal/testutil/oidctest"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

type judgeFunc func(authz.Identity, authz.Attributes) authz.Verdict

func (f judgeFunc) MayPerform(_ context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	return authz.Judgement{Verdict: f(id, a)}
}

// alice may do anything in team-a and nothing elsewhere.
var judge = judgeFunc(func(id authz.Identity, a authz.Attributes) authz.Verdict {
	if id.User == "issuer#alice" && a.Namespace == "team-a" {
		return authz.Yes
	}

	return authz.No
})

type browser struct {
	t      *testing.T
	client *http.Client
	base   string
}

func (b browser) get(path string) (int, string) {
	b.t.Helper()
	resp, err := b.client.Get(b.base + path)
	if err != nil {
		b.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	return resp.StatusCode, string(body)
}

func (b browser) post(path string, form url.Values) (int, string) {
	b.t.Helper()
	resp, err := b.client.PostForm(b.base+path, form)
	if err != nil {
		b.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	return resp.StatusCode, string(body)
}

var csrfField = regexp.MustCompile(`name="csrf" value="([^"]+)"`)

func newExplorer(t *testing.T) (browser, *oidctest.Provider) {
	t.Helper()
	logger := slog.New(slog.DiscardHandler)
	provider := oidctest.NewProvider(t, "alice")
	srv := httptest.NewUnstartedServer(nil)
	publicURL := "http://" + srv.Listener.Addr().String()
	verifier := auth.NewOIDCVerifier(auth.OIDCOptions{Issuer: provider.ID, JWKSURI: provider.JWKSURL, Audience: publicURL + "/mcp",
		NamespacesClaim: "codemowers.io/namespaces", UsernameClaim: "sub", GroupsClaim: "groups"})

	labels := map[string]string{"app": "api"}
	k := fake.NewClientset(
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api", UID: "d1"},
			Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "registry.example.com/api:1"}}}}}},
	)
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	scope := &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a", "team-b"}, nil }, Judge: judge}
	cache := &workloads.Cache{Kubernetes: k, Metadata: metadatafake.NewSimpleMetadataClient(scheme), Dynamic: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		Discovery: k.Discovery(), Judge: judge, Scope: scope, Logger: logger}
	cache.Start(ctx)

	platform := kubetest.ProvisioningCluster()
	cat := catalog.New(platform.Kubernetes, platform.Dynamic)
	f := facts.New(facts.Options{Kubernetes: platform.Kubernetes, Dynamic: platform.Dynamic, Catalog: cat, Judge: judge,
		ClusterFactTTL: time.Minute, TopologyTTL: time.Minute, OperatorTTL: time.Minute})

	id := "bravo.example.com"
	u := &UI{
		PublicURL: publicURL, Issuer: provider.ID, ClientID: "explorer",
		Verify: func(ctx context.Context, raw string) (*auth.Caller, error) {
			caller, _, err := verifier.Verify(ctx, raw)

			return caller, err
		},
		Mapping: auth.Mapping{UsernameClaim: "sub", GroupsClaim: "groups", UsernamePrefix: "issuer#"},
		Cluster: cluster.NewIdentity(&id, nil, ""), Scope: scope, Workloads: cache,
		// Nothing listens here, so a restart is refused by the transport.
		Actions: &workloads.Actions{Config: &rest.Config{Host: "http://127.0.0.1:1", Timeout: time.Second}},
		Catalog: cat, Provisioning: service.New(f, judge, 20), Logger: logger,
	}
	srv.Config.Handler = u.Handler()
	srv.Start()
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)

	return browser{t: t, client: &http.Client{Jar: jar, Timeout: 20 * time.Second}, base: srv.URL}, provider
}

func TestExplorerSignInAndPages(t *testing.T) {
	b, _ := newExplorer(t)

	status, body := b.get("/ui")
	if status != 200 || !strings.Contains(body, `href="/ui/login"`) {
		t.Fatalf("anonymous /ui = %d %s", status, body)
	}

	// Sign in: the fake provider approves and redirects straight back.
	status, body = b.get("/ui/login")
	if status != 200 || !strings.Contains(body, `href="/ui/namespaces/team-a"`) || strings.Contains(body, "team-b") {
		t.Fatalf("after sign-in = %d %s", status, body)
	}
	if !strings.Contains(body, "alice") || !strings.Contains(body, "bravo.example.com") {
		t.Errorf("header lacks user or cluster: %s", body)
	}

	resp, err := b.client.Get(b.base + "/ui/namespaces/team-a")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") || strings.Contains(csp, "script-src") {
		t.Errorf("CSP = %q", csp)
	}
	if !strings.Contains(string(page), "api") || !strings.Contains(string(page), "registry.example.com/api:1") || !strings.Contains(string(page), ">Restart<") {
		t.Fatalf("namespace page = %s", page)
	}
	csrf := csrfField.FindStringSubmatch(string(page))[1]

	restart := url.Values{"name": {"api"}, "uid": {"d1"}, "apiVersion": {"apps/v1"}, "kind": {"Deployment"}}
	if status, _ := b.post("/ui/namespaces/team-a/restart", restart); status != http.StatusForbidden {
		t.Errorf("restart without CSRF token = %d", status)
	}
	restart.Set("csrf", csrf)
	if status, body := b.post("/ui/namespaces/team-a/restart", restart); status != 200 || !strings.Contains(body, "Refused:") {
		t.Errorf("restart = %d %s", status, body)
	}

	if _, body := b.get("/ui/namespaces/team-a/readiness"); !strings.Contains(body, "codemowers.io/tenant=acme") ||
		!strings.Contains(body, "acme.apps.example.com") {
		t.Errorf("readiness = %s", body)
	}
	if _, body := b.get("/ui/namespaces/team-b/readiness"); !strings.Contains(body, "were withheld") {
		t.Errorf("withheld readiness = %s", body)
	}
	if _, body := b.get("/ui/catalog"); !strings.Contains(body, "tenant-ingress-hosts") || !strings.Contains(body, "cephfs") ||
		!strings.Contains(body, "letsencrypt") {
		t.Errorf("catalog = %s", body)
	}
	if status, _ := b.get("/ui/nowhere"); status != 404 {
		t.Errorf("unknown page = %d", status)
	}

	if status, body := b.post("/ui/logout", url.Values{"csrf": {csrf}}); status != 200 || !strings.Contains(body, `href="/ui/login"`) {
		t.Errorf("after sign-out = %d %s", status, body)
	}
}

func TestExplorerRefusesForeignCallback(t *testing.T) {
	b, _ := newExplorer(t)

	// A callback this browser did not start is refused, whatever its code.
	status, body := b.get("/ui/callback?state=forged&code=whatever")
	if status != http.StatusBadRequest || !strings.Contains(body, "did not start in this browser") {
		t.Errorf("forged callback = %d %s", status, body)
	}
}
