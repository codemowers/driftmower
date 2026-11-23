package mcpserver

import (
	"context"
	"log/slog"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/useraccess"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

func TestOptionalAPITools(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		name := "installed"
		if disabled {
			name = "missing"
		}
		t.Run(name, func(t *testing.T) {
			var findings FindingsSource
			if !disabled {
				findings = staticReports{}
			}
			session := connectTo(t, New(Deps{Findings: findings, Logger: slog.New(slog.DiscardHandler), UserAccess: &useraccess.Service{OIDCUsersDisabled: disabled}, Workloads: &Workloads{Cache: &workloads.Cache{}}, ImageInventoryDisabled: disabled}))
			result, err := session.ListTools(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			names := map[string]bool{}
			for _, tool := range result.Tools {
				names[tool.Name] = true
			}
			for _, tool := range []string{"list_oidc_users", "get_oidc_user_access", "get_image_scans", "get_workload_findings", "get_source_findings"} {
				if names[tool] == disabled {
					t.Errorf("%s availability=%v with disabled=%v", tool, names[tool], disabled)
				}
			}
			for _, tool := range []string{"list_service_accounts", "get_service_account_access", "get_my_access"} {
				if !names[tool] {
					t.Errorf("missing core access tool %s", tool)
				}
			}
		})
	}
}
