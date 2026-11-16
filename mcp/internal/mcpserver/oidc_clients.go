package mcpserver

import (
	"context"
	"net/url"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var oidcClientsGVR = schema.GroupVersionResource{Group: "codemowers.cloud", Version: "v1", Resource: "oidcclients"}

type oidcClientApplication struct {
	application
	ClientName   string `json:"clientName"`
	DisplayOrder int64  `json:"displayOrder"`
}

type oidcClientsOutput struct {
	OIDCClients []oidcClientApplication `json:"oidcClients"`
	Warnings    []string                `json:"warnings"`
}

func addOIDCClientsTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "list_oidc_clients", Title: "List registered applications", Description: "List public application metadata from enabled OIDCClient registrations the caller may list. Checks caller Kubernetes RBAC for OIDCClients in each namespace. Returns names, launch URLs, descriptions and configured access groups, never credentials or redirect settings. Registration visibility does not guarantee application sign-in or health.", InputSchema: inputSchema[namespaceInput](nil), Annotations: readOnly("List registered applications")}, func(ctx context.Context, req *mcp.CallToolRequest, in namespaceInput) (*mcp.CallToolResult, oidcClientsOutput, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, oidcClientsOutput{}, err
		}
		out, err := collectOIDCClients(ctx, w, id, in.Namespace)
		return nil, out, err
	})
}

func collectOIDCClients(ctx context.Context, w *Workloads, id authz.Identity, namespace string) (oidcClientsOutput, error) {
	out := oidcClientsOutput{OIDCClients: []oidcClientApplication{}, Warnings: []string{}}
	namespaces := []string{namespace}
	if namespace == "" {
		var err error
		namespaces, err = w.Cache.Scope.ListNamespaces(ctx)
		if err != nil {
			return out, err
		}
		slices.Sort(namespaces)
		limit := w.Cache.Scope.MaxNamespaces
		if limit <= 0 {
			limit = 2000
		}
		if len(namespaces) > limit {
			namespaces = namespaces[:limit]
			out.Warnings = append(out.Warnings, "OIDCClient namespace discovery is incomplete.")
		}
	}
	for _, ns := range namespaces {
		access := w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Group: oidcClientsGVR.Group, Resource: oidcClientsGVR.Resource, Verb: "list"})
		if access.Verdict != authz.Yes {
			if namespace != "" || access.Verdict != authz.No {
				out.Warnings = append(out.Warnings, ns+": listing OIDCClients is not authorized or could not be evaluated.")
			}
			continue
		}
		clients, err := w.Cache.Dynamic.Resource(oidcClientsGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			out.Warnings = append(out.Warnings, ns+": OIDCClient inventory unavailable.")
			continue
		}
		for _, client := range clients.Items {
			disabled, _, _ := unstructured.NestedBool(client.Object, "spec", "disabled")
			if disabled || client.GetDeletionTimestamp() != nil {
				continue
			}
			uri, _, _ := unstructured.NestedString(client.Object, "spec", "uri")
			if uri == "" {
				ingressName, _, _ := unstructured.NestedString(client.Object, "spec", "ingressRef", "name")
				if ingressName != "" {
					if w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Group: "networking.k8s.io", Resource: "ingresses", Name: ingressName, Verb: "get"}).Verdict != authz.Yes {
						out.Warnings = append(out.Warnings, ns+"/"+client.GetName()+": resolving the registered Ingress is not authorized.")
						continue
					}
					ingress, err := w.Cache.Kubernetes.NetworkingV1().Ingresses(ns).Get(ctx, ingressName, metav1.GetOptions{})
					if err != nil {
						out.Warnings = append(out.Warnings, ns+"/"+client.GetName()+": registered Ingress unavailable.")
						continue
					}
					for _, rule := range ingress.Spec.Rules {
						if rule.Host != "" && !strings.Contains(rule.Host, "*") {
							uri = "https://" + rule.Host + "/"
							break
						}
					}
				}
			}
			u, err := url.Parse(uri)
			if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
				continue
			}
			name, _, _ := unstructured.NestedString(client.Object, "spec", "displayName")
			if name == "" {
				name = client.GetName()
			}
			groups, _, _ := unstructured.NestedStringSlice(client.Object, "spec", "allowedGroups")
			if groups == nil {
				groups = []string{}
			}
			order, _, _ := unstructured.NestedInt64(client.Object, "spec", "displayOrder")
			var description *string
			if text := client.GetAnnotations()["kubernetes.io/description"]; text != "" {
				description = &text
			}
			out.OIDCClients = append(out.OIDCClients, oidcClientApplication{application: application{Key: ns + "/" + client.GetName(), Name: name, URL: u.String(), Namespace: ns, Groups: groups, Description: description}, ClientName: client.GetName(), DisplayOrder: order})
		}
	}
	slices.SortFunc(out.OIDCClients, func(a, b oidcClientApplication) int {
		if a.DisplayOrder < b.DisplayOrder {
			return -1
		}
		if a.DisplayOrder > b.DisplayOrder {
			return 1
		}
		if name := strings.Compare(a.Name, b.Name); name != 0 {
			return name
		}
		return strings.Compare(a.Key, b.Key)
	})
	return out, nil
}
