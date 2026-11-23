package mcpserver

import (
	"context"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"strings"
	"time"
)

func addInventoryTools(s *mcp.Server, w *Workloads, mapping auth.Mapping, clusterID string, prometheusURL func(context.Context) *string) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_inventory_status", InputSchema: inputSchema[struct{}](nil), Description: "Cluster identity and inventory revision.", Annotations: readOnly("Inventory status")}, func(ctx context.Context, req *mcp.CallToolRequest, in struct{}) (*mcp.CallToolResult, map[string]any, error) {
		if _, err := callerIdentity(req, mapping); err != nil {
			return nil, nil, err
		}
		var prom *string
		if prometheusURL != nil {
			prom = prometheusURL(ctx)
		}
		return text("Connected to " + clusterID), map[string]any{"clusterContext": clusterID, "revision": w.Cache.CurrentRevision(), "observedAt": time.Now().UTC().Format(time.RFC3339), "subscriptionUri": dashboardURI(req.Session), "prometheusUrl": prom, "missingComponents": w.MissingComponents}, nil
	})
}

// argoApplication reads Argo CD's tracking ID,
// `<application>:<group>/<Kind>:<namespace>/<name>`, where an application
// outside Argo CD's own namespace is `<namespace>_<name>`. url opens the
// resource in the application tree, detailsUrl the application itself.
func argoApplication(trackingID, argoURL string) map[string]any {
	app, resource, ok := strings.Cut(trackingID, ":")
	if !ok || app == "" {
		return nil
	}
	out := map[string]any{"name": app}
	gk, ref, hasResource := strings.Cut(resource, ":")
	if hasResource {
		_, kind, _ := strings.Cut(gk, "/")
		out["kind"], out["resourceRef"] = kind, ref
	}
	if argoURL != "" {
		appNamespace, appName := "argocd", app
		if ns, name, ok := strings.Cut(app, "_"); ok {
			appNamespace, appName = ns, name
		}
		base := strings.TrimRight(argoURL, "/") + "/applications/" + url.PathEscape(appNamespace) + "/" + url.PathEscape(appName)
		tree := func(node string) string {
			return base + "?view=tree&orphaned=false&resource=&node=" + url.QueryEscape(node+"/0")
		}
		out["detailsUrl"] = tree("argoproj.io/Application/" + appNamespace + "/" + appName)
		out["url"] = out["detailsUrl"]
		if hasResource {
			out["url"] = tree(gk + "/" + ref)
		}
	}

	return out
}
