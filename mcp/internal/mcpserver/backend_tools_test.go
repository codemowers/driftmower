package mcpserver

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/backend"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/tenancy"
	"github.com/codemowers/driftmower-mcp/internal/testutil/fakebackend"
)

func TestBackendTools(t *testing.T) {
	fake := fakebackend.New(t, nil)
	client := &backend.Client{BaseURL: fake.URL, Token: fakebackend.DefaultToken}
	rows := &backend.RowLoader{Client: client}
	logger := slog.New(slog.DiscardHandler)
	id := "bravo.example.com"
	// Every request is alice's, whose token claims no namespaces: under the
	// claim policy she sees nothing, and the notes say why.
	s := connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger, Mapping: auth.Mapping{UsernameClaim: "sub"},
		Backend: &Backend{
			Searcher: &backend.Searcher{Client: client, Rows: rows, DefaultLimit: 20, MaximumLimit: 100},
			Planner:  &backend.Planner{Client: client, Rows: rows, DefaultLimit: 20, MaximumLimit: 100},
			Tenancy:  &Tenancy{Policy: tenancy.PolicyClaim, Logger: logger},
		},
	}))

	text, out := call(t, s, "search_workloads", map[string]any{"query": "cert-manager"})
	if len(out["matches"].([]any)) != 0 || !strings.Contains(text, "carries no namespaces claim") {
		t.Errorf("search = %s %v", text, out)
	}

	text, out = call(t, s, "plan_image_updates", map[string]any{"versionStatuses": []string{"minor_behind", "major_behind"}})
	if out["status"] != "ok" || out["filters"].(map[string]any)["versionStatuses"].([]any)[0] != "major_behind" ||
		!strings.HasPrefix(text, "0 advisory action(s)") {
		t.Errorf("plan = %s %v", text, out)
	}
}

func TestBackendToolsUnrestricted(t *testing.T) {
	fake := fakebackend.New(t, nil)
	client := &backend.Client{BaseURL: fake.URL, Token: fakebackend.DefaultToken}
	rows := &backend.RowLoader{Client: client}
	logger := slog.New(slog.DiscardHandler)
	id := "bravo.example.com"
	// A caller who may list pods everywhere is unrestricted.
	resolver := &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return nil, nil }, Judge: allowAll{}}
	s := connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger, Mapping: auth.Mapping{UsernameClaim: "sub"},
		Backend: &Backend{
			Searcher: &backend.Searcher{Client: client, Rows: rows, DefaultLimit: 20, MaximumLimit: 100},
			Planner:  &backend.Planner{Client: client, Rows: rows, DefaultLimit: 20, MaximumLimit: 100},
			Tenancy:  &Tenancy{Policy: tenancy.PolicyUnion, Resolver: resolver, Mapping: auth.Mapping{UsernameClaim: "sub"}, Logger: logger},
		},
	}))

	text, out := call(t, s, "search_workloads", map[string]any{"query": "cert-manager"})
	if len(out["matches"].([]any)) == 0 || !strings.Contains(text, "workload(s) match `cert-manager`") {
		t.Errorf("search = %s", text)
	}

	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 20; page++ {
		args := map[string]any{"limit": 3}
		if cursor != "" {
			args["cursor"] = cursor
		}
		_, out = call(t, s, "plan_image_updates", args)
		for _, a := range out["actions"].([]any) {
			id := a.(map[string]any)["actionId"].(string)
			if seen[id] {
				t.Fatalf("action %s repeated across pages", id)
			}
			seen[id] = true
		}
		next, _ := out["nextCursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	if total := int(out["summary"].(map[string]any)["totalActions"].(float64)); total == 0 || len(seen) != total {
		t.Errorf("paged %d actions, summary says %d", len(seen), total)
	}
}
