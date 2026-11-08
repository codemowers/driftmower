package mcpserver

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type application struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	URL         string   `json:"url"`
	Namespace   string   `json:"namespace"`
	Groups      []string `json:"groups"`
	Description *string  `json:"description"`
}
type applicationsOutput struct {
	Applications []application `json:"applications"`
	Warnings     []string      `json:"warnings"`
}

func addApplicationsTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "list_applications", Title: "List application endpoints", Description: "Discover application URLs from Ingress rules in namespaces visible to the caller. Checks caller list permission for Ingresses separately. TLS hosts use HTTPS; wildcard hosts are omitted. This lists configured routes, not a guarantee of application access or health. Warnings identify incomplete discovery.", InputSchema: inputSchema[namespaceInput](nil), Annotations: readOnly("List application endpoints")}, func(ctx context.Context, req *mcp.CallToolRequest, in namespaceInput) (*mcp.CallToolResult, applicationsOutput, error) {
		out := applicationsOutput{Applications: []application{}, Warnings: []string{}}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, out, err
		}
		namespaces := []string{in.Namespace}
		if in.Namespace == "" {
			scope, err := w.Cache.Scope.Resolve(ctx, id, nil)
			if err != nil {
				return nil, out, err
			}
			namespaces = scope.Namespaces
			if scope.Truncated || len(scope.Unknown) > 0 {
				out.Warnings = append(out.Warnings, "Namespace visibility is incomplete.")
			}
		}
		seen := map[string]bool{}
		for _, ns := range namespaces {
			if w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Group: "networking.k8s.io", Resource: "ingresses", Verb: "list"}).Verdict != authz.Yes {
				out.Warnings = append(out.Warnings, ns+": listing Ingresses is not authorized.")
				continue
			}
			items, err := w.Cache.Kubernetes.NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
			if err != nil {
				out.Warnings = append(out.Warnings, fmt.Sprintf("%s: Ingress inventory unavailable.", ns))
				continue
			}
			for _, ing := range items.Items {
				tls := map[string]bool{}
				for _, t := range ing.Spec.TLS {
					for _, h := range t.Hosts {
						tls[h] = true
					}
				}
				for _, rule := range ing.Spec.Rules {
					if rule.Host == "" || strings.Contains(rule.Host, "*") {
						continue
					}
					scheme := "http"
					if tls[rule.Host] {
						scheme = "https"
					}
					paths := []string{"/"}
					if rule.HTTP != nil && len(rule.HTTP.Paths) > 0 {
						paths = nil
						for _, p := range rule.HTTP.Paths {
							path := p.Path
							if path == "" {
								path = "/"
							}
							paths = append(paths, path)
						}
					}
					for _, path := range paths {
						url := scheme + "://" + rule.Host + path
						key := ns + "/" + url
						if seen[key] {
							continue
						}
						seen[key] = true
						out.Applications = append(out.Applications, application{Key: key, Name: ing.Name, Namespace: ns, URL: url, Groups: []string{}})
					}
				}
			}
		}
		sort.Slice(out.Applications, func(i, j int) bool { return out.Applications[i].Key < out.Applications[j].Key })
		return nil, out, nil
	})
}
