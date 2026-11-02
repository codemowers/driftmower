package httpserver

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/catalog"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/facts"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower-mcp/internal/testutil/kubetest"
)

func TestCapabilitiesRoute(t *testing.T) {
	c := kubetest.ProvisioningCluster()
	cat := catalog.New(c.Kubernetes, c.Dynamic)
	f := facts.New(facts.Options{Kubernetes: c.Kubernetes, Dynamic: c.Dynamic, Catalog: cat, Judge: judge,
		ClusterFactTTL: time.Minute, TopologyTTL: time.Minute, OperatorTTL: time.Minute})
	h := &Capabilities{Service: service.New(f, judge, 2), Mapping: auth.Mapping{UsernameClaim: "sub"}, Logger: logger}

	get := func(method, query string) (int, string, map[string]any) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, capabilitiesPath+query, nil))
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)

		return rec.Code, rec.Header().Get("Cache-Control"), body
	}

	cases := []struct {
		method, query string
		status        int
		errorCode     string
	}{
		{"POST", "", 405, "method_not_allowed"},
		{"GET", "?ns=a,b,c", 400, "too_many_namespaces"},
		{"GET", "?access=everything", 400, "unknown_access_detail"},
		{"GET", "?offering=oracle", 400, "unknown_offering"},
	}
	for _, tc := range cases {
		if status, _, body := get(tc.method, tc.query); status != tc.status || body["error"] != tc.errorCode {
			t.Errorf("%s %s = %d %v", tc.method, tc.query, status, body)
		}
	}

	// Unauthenticated: facts are returned and nothing is withheld, but no
	// access matrix is built.
	status, cache, body := get("GET", "?ns=team-a,team-a&offering=postgres")
	if status != 200 || cache != "no-store" || body["inCluster"] != true {
		t.Fatalf("capabilities = %d %v", status, body)
	}
	ns := body["namespaces"].([]any)
	if len(ns) != 1 || ns[0].(map[string]any)["access"] != nil || ns[0].(map[string]any)["mayCreate"] != "unknown" {
		t.Errorf("namespaces = %v", ns)
	}
	hostRules := body["ingress"].(map[string]any)["hostRules"].([]any)
	if !strings.HasPrefix(hostRules[0].(map[string]any)["exactHost"].(string), "acme.") {
		t.Errorf("host rules = %v", hostRules)
	}
}
