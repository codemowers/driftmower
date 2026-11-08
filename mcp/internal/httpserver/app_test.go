package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/mcpserver"
	"github.com/codemowers/driftmower/mcp/internal/metrics"
	"github.com/codemowers/driftmower/mcp/internal/testutil/oidctest"
)

var logger = slog.New(slog.DiscardHandler)

type judgeFunc func(ctx context.Context, id authz.Identity, attrs authz.Attributes) authz.Judgement

func (f judgeFunc) MayPerform(ctx context.Context, id authz.Identity, attrs authz.Attributes) authz.Judgement {
	return f(ctx, id, attrs)
}

// The judge grants alice list-pods in team-a only.
var judge = judgeFunc(func(_ context.Context, id authz.Identity, attrs authz.Attributes) authz.Judgement {
	if id.User == "issuer#alice" && attrs.Namespace == "team-a" {
		return authz.Judgement{Verdict: authz.Yes}
	}

	return authz.Judgement{Verdict: authz.No}
})

type fixture struct {
	url     string
	issuer  *oidctest.Issuer
	metrics *metrics.Metrics
}

func start(t *testing.T, authenticated bool) *fixture {
	t.Helper()
	m := metrics.New()
	id := "bravo.example.com"
	f := &fixture{metrics: m}
	srv := httptest.NewUnstartedServer(nil)
	publicURL := "http://" + srv.Listener.Addr().String()
	c := cluster.NewIdentity(&id, nil, publicURL)
	mapping := auth.Mapping{UsernameClaim: "sub", GroupsClaim: "groups", UsernamePrefix: "issuer#"}

	opts := AppOptions{
		PublicURL:       publicURL,
		Cluster:         c,
		OAuthClientID:   "claude",
		BrowserClientID: "dashboard",
		AllowedOrigins:  []string{"http://localhost:8080", "https://dashboard.example.com"},
		SessionIdle:     time.Minute,
		Metrics:         m,
		Logger:          logger,
		MCP: mcpserver.New(mcpserver.Deps{
			Cluster: c, Version: "test", Logger: logger, Metrics: m, Mapping: mapping,
			Scope: &authz.ScopeResolver{
				ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a", "team-b"}, nil },
				Judge:          judge,
			},
		}),
	}
	if authenticated {
		f.issuer = oidctest.New(t, "https://auth.example.com")
		opts.Auth = &auth.Authenticator{
			OIDC: auth.NewOIDCVerifier(auth.OIDCOptions{
				Issuer: f.issuer.ID, JWKSURI: f.issuer.JWKSURL, Audience: publicURL + "/mcp",
				NamespacesClaim: "codemowers.io/namespaces", UsernameClaim: "sub", GroupsClaim: "groups",
			}),
			Resource: publicURL + "/mcp",
			Issuer:   f.issuer.ID,
		}
	}
	srv.Config.Handler = NewApp(opts)
	srv.Start()
	t.Cleanup(srv.Close)
	f.url = srv.URL

	return f
}

func connect(t *testing.T, f *fixture, client *http.Client) (*mcp.ClientSession, error) {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil)

	return c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: f.url + "/mcp", HTTPClient: client, DisableStandaloneSSE: true, MaxRetries: -1,
	}, nil)
}

func callJSON(t *testing.T, s *mcp.ClientSession, name string) (*mcp.CallToolResult, map[string]any) {
	t.Helper()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if res.StructuredContent != nil {
		b, _ := json.Marshal(res.StructuredContent)
		_ = json.Unmarshal(b, &out)
	}

	return res, out
}

func TestUnauthenticatedServer(t *testing.T) {
	f := start(t, false)

	resp, err := http.Get(f.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "http://"+strings.TrimPrefix(f.url, "http://")+"/mcp") ||
		strings.Contains(string(body), "--client-id") || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Errorf("landing = %d %s", resp.StatusCode, body)
	}

	resp, _ = http.Get(f.url + "/nope")
	body, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 404 || strings.TrimSpace(string(body)) != `{"error":"not_found"}` {
		t.Errorf("unknown path = %d %s", resp.StatusCode, body)
	}
	if resp, _ := http.Get(f.url + auth.MetadataPath); resp.StatusCode != 404 {
		t.Errorf("metadata served without authentication: %d", resp.StatusCode)
	}

	s, err := connect(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	tools, err := s.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint || tool.OutputSchema == nil {
			t.Errorf("%s: annotations %+v, output schema %v", tool.Name, tool.Annotations, tool.OutputSchema)
		}
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"get_cluster_identity", "list_accessible_namespaces"}) {
		t.Errorf("tools = %v", names)
	}
	if !strings.Contains(s.InitializeResult().Instructions, "list_accessible_namespaces") ||
		s.InitializeResult().ServerInfo.Name != "driftmower-bravo-example-com" {
		t.Errorf("initialize = %+v", s.InitializeResult())
	}

	_, out := callJSON(t, s, "get_cluster_identity")
	if out["cluster"].(map[string]any)["id"] != "bravo.example.com" || !strings.Contains(out["contextSelection"].(string), "bravo.example.com/<namespace>") {
		t.Errorf("identity = %+v", out)
	}

	res, _ := callJSON(t, s, "list_accessible_namespaces")
	if !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "requires an authenticated caller") {
		t.Errorf("anonymous namespace listing = %+v", res)
	}

	guide, err := s.ReadResource(context.Background(), &mcp.ReadResourceParams{URI: "driftmower://cluster/discovery-guide"})
	if err != nil || !strings.HasPrefix(guide.Contents[0].Text, "This MCP connection identifies cluster") {
		t.Errorf("guide = %+v %v", guide, err)
	}

	if got := testutil.ToFloat64(f.metrics.Sessions); got != 1 {
		t.Errorf("sessions_total = %v", got)
	}
}

func TestAuthenticatedServer(t *testing.T) {
	f := start(t, true)
	resource := f.url + "/mcp"

	resp, err := http.Post(f.url+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 401 || resp.Header.Get("WWW-Authenticate") != `Bearer resource_metadata="`+f.url+auth.MetadataPath+`"` {
		t.Errorf("no token = %d %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
	}

	resp, _ = http.Get(f.url + auth.MetadataPath)
	var meta map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&meta)
	_ = resp.Body.Close()
	if meta["resource"] != resource || !slices.Contains(meta["scopes_supported"].([]any), any("offline_access")) {
		t.Errorf("metadata = %+v", meta)
	}

	resp, _ = http.Get(f.url + "/")
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), "--client-id &#39;claude&#39;") || !strings.Contains(string(body), "Codex project config") {
		t.Errorf("authenticated landing lacks client ID: %s", body)
	}

	wrongAudience := f.issuer.Token(t, "alice", "https://ui.example.com", nil)
	if _, err := connect(t, f, oidctest.BearerClient(wrongAudience)); err == nil {
		t.Error("token for another audience was accepted")
	}

	alice := f.issuer.Token(t, "alice", resource, nil)
	s, err := connect(t, f, oidctest.BearerClient(alice))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	res, out := callJSON(t, s, "list_accessible_namespaces")
	if res.IsError {
		t.Fatalf("list_accessible_namespaces = %+v", res.Content)
	}
	if ns := out["namespaces"].([]any); len(ns) != 1 || ns[0] != "team-a" || out["identity"].(map[string]any)["user"] != "issuer#alice" {
		t.Errorf("namespaces = %+v", out)
	}

	// Another subject may not reuse alice's session.
	req, _ := http.NewRequest("POST", f.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer "+f.issuer.Token(t, "mallory", resource, nil))
	req.Header.Set("Mcp-Session-Id", s.ID())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("hijacked session = %d", resp.StatusCode)
	}
}

func TestInvalidator(t *testing.T) {
	var calls []string
	m := metrics.New()
	v := &Invalidator{
		SharedToken:     "s3cret",
		AllowedSubjects: []string{"system:serviceaccount:argocd:argocd-server"},
		ReviewToken: func(_ context.Context, token string) (string, error) {
			if token == "sa-token" {
				return "system:serviceaccount:argocd:argocd-server", nil
			}
			if token == "broken" {
				return "", errors.New("apiserver down")
			}

			return "system:serviceaccount:other:x", nil
		},
		UsernamePrefix:      "issuer#",
		ClearReviews:        func() int { calls = append(calls, "clear"); return 3 },
		InvalidateNamespace: func(ns string) int { calls = append(calls, "ns:"+ns); return 1 },
		InvalidateUser:      func(u string) int { calls = append(calls, "user:"+u); return 2 },
		InvalidateFacts:     func() { calls = append(calls, "facts") },
		Metrics:             m,
		Logger:              logger,
	}
	post := func(method, token, body string) (int, string) {
		req := httptest.NewRequest(method, invalidatePath, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		v.ServeHTTP(rec, req)

		return rec.Code, strings.TrimSpace(rec.Body.String())
	}

	cases := []struct {
		method, token, body string
		status              int
		response            string
	}{
		{"GET", "s3cret", "", 405, `{"error":"method_not_allowed"}`},
		{"POST", "", "", 401, ""},
		{"POST", "wrong", "", 403, ""},
		{"POST", "broken", "", 403, ""},
		{"POST", "s3cret", "{", 400, `{"error":"invalid_json"}`},
		{"POST", "s3cret", "", 400, ""},
		{"POST", "s3cret", `{"scope":"namespace"}`, 400, `{"error":"missing_namespace"}`},
		{"POST", "s3cret", `{"scope":"identity"}`, 400, `{"error":"missing_sub"}`},
		{"POST", "s3cret", strings.Repeat(" ", 5000), 413, ""},
		{"POST", "s3cret", `{"scope":"all"}`, 200, `{"cleared":3,"scope":"all"}`},
		{"POST", "sa-token", `{"scope":"namespace","namespace":"team-a"}`, 200, `{"cleared":1,"scope":"namespace"}`},
		{"POST", "s3cret", `{"scope":"identity","sub":"alice"}`, 200, `{"cleared":2,"scope":"identity"}`},
	}
	for _, tc := range cases {
		status, body := post(tc.method, tc.token, tc.body)
		if status != tc.status || (tc.response != "" && body != tc.response) {
			t.Errorf("%s %q %q = %d %s, want %d %s", tc.method, tc.token, tc.body, status, body, tc.status, tc.response)
		}
	}
	if !slices.Equal(calls, []string{"clear", "facts", "ns:team-a", "user:issuer#alice"}) {
		t.Errorf("calls = %v", calls)
	}
	if got := testutil.ToFloat64(m.Invalidations.WithLabelValues("webhook")); got != 3 {
		t.Errorf("invalidations = %v", got)
	}

	disabled := &Invalidator{Metrics: m, Logger: logger}
	rec := httptest.NewRecorder()
	disabled.ServeHTTP(rec, httptest.NewRequest("POST", invalidatePath, nil))
	if rec.Code != 404 {
		t.Errorf("disabled = %d", rec.Code)
	}
}

func TestDashboardClientForOrigin(t *testing.T) {
	f := start(t, true)
	for _, tc := range []struct {
		origin, client string
		status         int
	}{
		{"https://dashboard.example.com", "dashboard", 200},
		{"http://localhost:8080", "claude", 200},
		{"http://localhost:9999", "", 403},
		{"https://evil.example", "", 403},
	} {
		req, _ := http.NewRequest("GET", f.url+"/api/client-config", nil)
		req.Header.Set("Origin", tc.origin)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if res.StatusCode == 200 {
			err = json.NewDecoder(res.Body).Decode(&body)
		}
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != tc.status {
			t.Fatalf("%s: status %d", tc.origin, res.StatusCode)
		}
		if tc.status == 200 && (body["clientId"] != tc.client || body["resource"] != f.url+"/mcp") {
			t.Fatalf("wrong client/audience: %v", body)
		}
	}
}
