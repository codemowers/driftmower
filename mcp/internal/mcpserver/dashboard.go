package mcpserver

import (
	"context"
	"fmt"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"strings"
	"time"
)

type podInventory struct {
	Items    []workloads.PodSnapshot `json:"items"`
	Total    int                     `json:"total"`
	Revision string                  `json:"revision"`
	Warnings []string                `json:"warnings,omitempty"`
}

func addInventoryTools(s *mcp.Server, w *Workloads, mapping auth.Mapping, clusterID string, prometheusURL func(context.Context) *string) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_inventory_status", InputSchema: inputSchema[struct{}](nil), Description: "Cheap connection identity and inventory revision. Does not load workload, Pod, image, Helm, findings or SBOM data. Use get_workloads, list_pod_inventory, get_image_metadata, list_helm_releases and the resource-usage tools for those domains.", Annotations: readOnly("Inventory status")}, func(ctx context.Context, req *mcp.CallToolRequest, in struct{}) (*mcp.CallToolResult, map[string]any, error) {
		if _, err := callerIdentity(req, mapping); err != nil {
			return nil, nil, err
		}
		var prom *string
		if prometheusURL != nil {
			prom = prometheusURL(ctx)
		}
		return text("Connected to " + clusterID), map[string]any{"clusterContext": clusterID, "revision": w.Cache.CurrentRevision(), "observedAt": time.Now().UTC().Format(time.RFC3339), "subscriptionUri": dashboardURI(req.Session), "prometheusUrl": prom}, nil
	})
	mcp.AddTool(s, &mcp.Tool{Name: "list_pod_inventory", Description: "Runtime Pod inventory for the namespaces the caller may list: identity, phase, node, IPs, container image references and running image IDs. No full specs, labels, image layers, findings or SBOM. Use get_workloads for ownership/dependencies, get_pod_resource_usage for CPU/memory, and get_workload_object for one Pod's details. Returns all matching Pods in one response.", InputSchema: inputSchema[namespaceInput](nil), Annotations: readOnly("List Pod runtime inventory")}, func(ctx context.Context, req *mcp.CallToolRequest, in namespaceInput) (*mcp.CallToolResult, podInventory, error) {
		out := podInventory{}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, out, err
		}
		rows, warnings, err := w.Cache.Pods(ctx, in.Namespace, id)
		if err != nil {
			return nil, out, err
		}
		out.Revision = w.Cache.CurrentRevision()
		out.Items = rows
		out.Total = len(rows)
		out.Warnings = warnings
		return text(fmt.Sprintf("%d Pods; %d total.", len(out.Items), out.Total)), out, nil
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
