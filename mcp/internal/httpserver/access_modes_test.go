package httpserver

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/testutil/oidctest"
)

func TestReadAllAccessModes(t *testing.T) {
	for _, mode := range []string{"oidc", "anonymous"} {
		t.Run(mode, func(t *testing.T) {
			f := start(t, mode == "oidc", mode)
			var client *http.Client
			if mode == "oidc" {
				if session, err := connect(t, f, nil); err == nil {
					session.Close()
					t.Fatal("OIDC-only accepted no token")
				}
				wrong := f.issuer.Token(t, "nobody", "wrong-audience", nil)
				if session, err := connect(t, f, oidctest.BearerClient(wrong)); err == nil {
					session.Close()
					t.Fatal("OIDC-only accepted wrong audience")
				}
				// This caller has no Kubernetes RBAC in either namespace.
				client = oidctest.BearerClient(f.issuer.Token(t, "nobody", f.url+"/mcp", nil))
			}
			session, err := connect(t, f, client)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			res, out := callJSON(t, session, "list_accessible_namespaces")
			if res.IsError {
				t.Fatalf("read-all denied: %+v", res)
			}
			if ns := out["namespaces"].([]any); len(ns) != 2 {
				t.Fatalf("namespaces %v", out)
			}
			if client == nil {
				client = http.DefaultClient
			}
			resp, err := client.Get(f.url + "/api/observability/cluster-health")
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatalf("browser reads: %d", resp.StatusCode)
			}
			if mode == "anonymous" {
				resp, err = client.Get(f.url + "/api/client-config")
				if err != nil {
					t.Fatal(err)
				}
				var config map[string]any
				json.NewDecoder(resp.Body).Decode(&config)
				resp.Body.Close()
				if config["authMode"] != "anonymous" || config["issuer"] != nil {
					t.Fatalf("anonymous config %v", config)
				}
			}
		})
	}
}
