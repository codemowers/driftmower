package mcpserver

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/catalog"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/facts"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower-mcp/internal/testutil/kubetest"
)

type allowAll struct{}

func (allowAll) MayPerform(context.Context, authz.Identity, authz.Attributes) authz.Judgement {
	return authz.Judgement{Verdict: authz.Yes}
}

// session connects to a server whose every request is authenticated as alice.
func session(t *testing.T) *mcp.ClientSession {
	t.Helper()
	logger := slog.New(slog.DiscardHandler)
	c := kubetest.ProvisioningCluster()
	cat := catalog.New(c.Kubernetes, c.Dynamic)
	f := facts.New(facts.Options{Kubernetes: c.Kubernetes, Dynamic: c.Dynamic, Catalog: cat, Judge: allowAll{},
		ClusterFactTTL: time.Minute, TopologyTTL: time.Minute, OperatorTTL: time.Minute})
	id := "bravo.example.com"
	mapping := auth.Mapping{UsernameClaim: "sub", GroupsClaim: "groups", UsernamePrefix: "issuer#"}

	return connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger, Mapping: mapping,
		Catalog: cat, Provisioning: service.New(f, allowAll{}, 20),
	}))
}

// connectTo serves server with every request authenticated as alice.
func connectTo(t *testing.T, server *mcp.Server) *mcp.ClientSession {
	t.Helper()
	caller := &auth.Caller{Sub: "alice", IdentityClaims: auth.IdentityClaims{Username: "alice"}}
	verify := func(context.Context, string, *http.Request) (*sdkauth.TokenInfo, error) {
		return auth.NewTokenInfo(caller, nil, time.Now().Add(time.Hour)), nil
	}
	handler := sdkauth.RequireBearerToken(verify, nil)(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	client := &http.Client{Transport: bearer{}}
	s, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(context.Background(),
		&mcp.StreamableClientTransport{Endpoint: srv.URL, HTTPClient: client, DisableStandaloneSSE: true, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	return s
}

type bearer struct{}

func (bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer test")

	return http.DefaultTransport.RoundTrip(r)
}

func call(t *testing.T, s *mcp.ClientSession, name string, args map[string]any) (string, map[string]any) {
	t.Helper()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	text := res.Content[0].(*mcp.TextContent).Text
	if res.IsError {
		t.Fatalf("%s returned an error: %s", name, text)
	}
	var out map[string]any
	b, _ := json.Marshal(res.StructuredContent)
	_ = json.Unmarshal(b, &out)

	return text, out
}

func TestProvisioningAndCatalogTools(t *testing.T) {
	s := session(t)

	tools, err := s.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 12 {
		var names []string
		for _, tool := range tools.Tools {
			names = append(names, tool.Name)
		}
		t.Errorf("tools = %v", names)
	}

	text, out := call(t, s, "describe_provisioning_platform", nil)
	if !strings.HasPrefix(text, "## Provisioning platform — 1 of 9 offerings ready") || out["status"] != "ok" {
		t.Errorf("platform = %s", text)
	}

	text, out = call(t, s, "list_offerings", map[string]any{"offering": "postgres", "namespace": "team-a"})
	offerings := out["offerings"].([]any)
	if len(offerings) != 1 || offerings[0].(map[string]any)["mayCreate"] != "yes" || !strings.Contains(text, "May you create it there: **yes**") {
		t.Errorf("offerings = %v\n%s", out, text)
	}

	_, out = call(t, s, "describe_namespace_readiness", map[string]any{"namespaces": []string{"team-a"}, "offering": "postgres"})
	ns := out["namespaces"].([]any)[0].(map[string]any)
	if _, leaked := ns["access"]; leaked || ns["creatableResources"] == nil {
		t.Errorf("readiness namespace = %v", ns)
	}

	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "describe_namespace_readiness", Arguments: map[string]any{"namespaces": []string{}}})
	if err != nil || !res.IsError {
		t.Errorf("empty namespaces accepted: %+v %v", res, err)
	}

	text, out = call(t, s, "check_access", map[string]any{"verb": "create", "group": "networking.k8s.io", "resource": "ingresses", "namespace": "team-a"})
	if out["verdict"] != "yes" || !strings.Contains(text, "tenant-ingress-hosts") {
		t.Errorf("check_access = %v\n%s", out, text)
	}

	_, out = call(t, s, "list_custom_resource_definitions", map[string]any{})
	if crds := out["customResources"].([]any); len(crds) != 1 || crds[0].(map[string]any)["name"] != "clusters.postgresql.cnpg.io" {
		t.Errorf("namespaced CRDs = %v", out)
	}
	_, out = call(t, s, "list_custom_resource_definitions", map[string]any{"scope": "All", "namespace": "team-a"})
	if crds := out["customResources"].([]any); len(crds) != 2 {
		t.Errorf("creatable CRDs = %v", out)
	}

	_, out = call(t, s, "describe_custom_resource_definition", map[string]any{"name": "clusters.postgresql.cnpg.io"})
	schema := out["versions"].([]any)[0].(map[string]any)["schema"].(map[string]any)
	props := schema["properties"].(map[string]any)
	if _, ok := props["status"]; ok || schema["required"].([]any)[0] != "spec" {
		t.Errorf("schema keeps status: %v", schema)
	}
	if _, ok := props["spec"].(map[string]any)["x-kubernetes-validations"]; ok {
		t.Error("schema keeps CEL")
	}

	_, out = call(t, s, "list_ingress_classes", nil)
	if classes := out["ingressClasses"].([]any); len(classes) != 1 {
		t.Errorf("ingress classes = %v", out)
	} else if _, ok := classes[0].(map[string]any)["isDefault"]; ok {
		t.Error("isDefault leaked")
	}
	_, out = call(t, s, "list_cluster_issuers", nil)
	if issuers := out["clusterIssuers"].([]any); len(issuers) != 1 || issuers[0].(map[string]any)["acme"].(map[string]any)["http01"] != true {
		t.Errorf("cluster issuers = %v", out)
	}
	_, out = call(t, s, "list_priority_classes", nil)
	if classes := out["priorityClasses"].([]any); len(classes) != 2 || classes[0].(map[string]any)["name"] != "low" {
		t.Errorf("priority classes = %v", out)
	}
	_, out = call(t, s, "list_storage_classes", nil)
	if classes := out["storageClasses"].([]any); len(classes) != 2 || classes[0].(map[string]any)["filesystemType"] != "ext4" {
		t.Errorf("storage classes = %v", out)
	}

	text, out = call(t, s, "list_admission_policies", nil)
	if !strings.HasPrefix(text, "name,description,kind,targets,bindings,conditional\n") ||
		!strings.Contains(text, "tenant-ingress-hosts,Ingress hosts carry the tenant prefix,ValidatingAdmissionPolicy,ingresses.networking.k8s.io versions=v1 operations=CREATE|UPDATE,tenant-ingress-hosts: all [Deny],false") ||
		!strings.Contains(text, "Unavailable policy APIs: MutatingAdmissionPolicy") {
		t.Errorf("policy CSV =\n%s", text)
	}
	if policies := out["policies"].([]any); len(policies) != 1 {
		t.Errorf("policies = %v", out)
	}
}
