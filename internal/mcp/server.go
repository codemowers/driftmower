// Package mcp serves the operator's tools over MCP's streamable HTTP
// transport in its stateless JSON form: every POST carries one JSON-RPC
// request and receives one response.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/codemowers/driftmower-operator/internal/authz"
	"github.com/codemowers/driftmower-operator/internal/findings"
	"github.com/codemowers/driftmower-operator/internal/workloads"
)

const protocolVersion = "2025-06-18"

var namespacePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// Server answers MCP requests from callers authenticated by projected
// ServiceAccount token.
type Server struct {
	Authorizer *authz.Authorizer
	Workloads  *workloads.Cache
	// Findings reads driftmower-crawler; nil disables the findings tools.
	Findings *findings.Client
	Log      *slog.Logger
	Version  string
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"params"`
}

const getWorkloadsDescription = "Start here for questions about applications, workloads, what runs in a namespace, " +
	"or which resources belong together. Specify namespace when known; omit it for a cross-namespace overview of the namespaces " +
	"whose Pods the caller may list. Returns root owners with their pods, images, ConfigMaps, Secrets, PVCs, Services, Ingresses " +
	"and Certificates; shared dependencies may appear under several roots. Includes scaled-to-zero built-in controllers. " +
	"Built-in controller ancestry is resolved recursively; custom roots are terminal owner references marked ownerReferenceOnly " +
	"unless an adapter verifies them (CNPG Clusters, whose TLS Secret and monitoring query references are associated). " +
	"Certificates join consumers through Pod Secret references or associated Ingress TLS. The Namespace/orphaned-workloads entry " +
	"holds unclaimed resources and standalone Pods; its orphaned mapping groups auxiliary generating owners by Kind.api-group and name. " +
	"Unused kube-root-ca.crt ConfigMaps, reflected copies, trust-manager bundles and Helm release records are not counted as orphans. " +
	"Orphaned does not mean safe to delete. Each collection is filtered by the caller's list permission. Warnings identify " +
	"incomplete inventory: missing objects must not be treated as confirmed absent. Secret and ConfigMap contents are never read. " +
	"Watch-backed live snapshot with an opaque revision; read workloads from structuredContent."

var tools = []map[string]any{{
	"name":        "get_workloads",
	"title":       "Get live workloads",
	"description": getWorkloadsDescription,
	"inputSchema": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
		"namespace": map[string]any{"type": "string", "maxLength": 63, "pattern": namespacePattern.String()},
	}},
	"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
}}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/mcp" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	identity, err := s.Authorizer.Authenticate(r.Context(), token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req request
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req) != nil || req.JSONRPC != "2.0" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if strings.HasPrefix(req.Method, "notifications/") {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	response := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	switch req.Method {
	case "initialize":
		response["result"] = map[string]any{"protocolVersion": protocolVersion, "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "driftmower-operator", "title": "Driftmower", "version": s.Version},
			"instructions": "Live workload inventory of this cluster, as the caller may read it. " +
				"Use get_workloads to find what runs where and which resources belong to it, and get_source_findings or " +
				"get_workload_findings for how far deployed versions are behind and which security advisories apply."}
	case "ping":
		response["result"] = map[string]any{}
	case "tools/list":
		list := tools
		if s.Findings != nil {
			list = append(slices.Clone(tools), findingsTools...)
		}
		response["result"] = map[string]any{"tools": list}
	case "tools/call":
		response["result"] = s.call(r.Context(), identity, req.Params.Name, req.Params.Arguments)
	default:
		response["error"] = map[string]any{"code": -32601, "message": "method not found"}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func toolError(message string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": message}}, "isError": true}
}

func (s *Server) call(ctx context.Context, id *authz.Identity, name string, raw json.RawMessage) map[string]any {
	switch name {
	case "get_workloads":
		var input struct {
			Namespace string `json:"namespace"`
		}
		if len(raw) > 0 && json.Unmarshal(raw, &input) != nil {
			return toolError("invalid arguments")
		}
		if input.Namespace != "" && (len(input.Namespace) > 63 || !namespacePattern.MatchString(input.Namespace)) {
			return toolError("invalid namespace")
		}
		result, err := s.getWorkloads(ctx, id, input.Namespace)
		if err != nil {
			s.Log.Error("get_workloads failed", "user", id.User, "error", err)
			return toolError("authorization checks failed; retry later")
		}
		roots, buckets := 0, 0
		for _, w := range result.Workloads {
			if w.Kind == "Namespace" {
				buckets++
			} else {
				roots++
			}
		}
		text := fmt.Sprintf("%d workloads; %d namespace orphan buckets.", roots, buckets)
		if len(result.Warnings) > 0 {
			text += " " + strings.Join(result.Warnings, " ")
		}
		return map[string]any{"structuredContent": result, "content": []map[string]any{{"type": "text", "text": text}}}
	case "get_source_findings":
		if s.Findings != nil {
			return s.getSourceFindings(ctx, id, raw)
		}
	case "get_workload_findings":
		if s.Findings != nil {
			return s.getWorkloadFindings(ctx, id, raw)
		}
	}
	return toolError("unknown tool " + name)
}

type workloadsResult struct {
	Workloads []*workloads.Workload `json:"workloads"`
	Warnings  []string              `json:"warnings,omitempty"`
	Revision  string                `json:"revision"`
}

// getWorkloads returns the inventory of one namespace, or of every namespace
// whose Pods the caller may list. A cached graph is not authorization: each
// source is included only when the caller may list it there.
func (s *Server) getWorkloads(ctx context.Context, id *authz.Identity, namespace string) (*workloadsResult, error) {
	result := &workloadsResult{Workloads: []*workloads.Workload{}, Revision: s.Workloads.Revision()}
	if !s.Workloads.Synced() {
		result.Warnings = append(result.Warnings, "Initial cluster inventory is still loading; results may be incomplete.")
	}
	candidates := []string{namespace}
	if namespace == "" {
		candidates = s.Workloads.Namespaces()
	}
	type outcome struct {
		workloads []*workloads.Workload
		warnings  []string
		err       error
	}
	outcomes := make([]outcome, len(candidates))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for i, ns := range candidates {
		wg.Go(func() {
			limit <- struct{}{}
			defer func() { <-limit }()
			pods, err := s.Authorizer.Allowed(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"})
			if err != nil {
				outcomes[i].err = err
				return
			}
			if !pods {
				// Without a namespace, unlisted namespaces are simply out of scope.
				if namespace != "" {
					outcomes[i].warnings = []string{ns + ": list pods is not authorized; inventory withheld."}
				}
				return
			}
			var denied []string
			var checkErr error
			permitted := func(source *workloads.Source) bool {
				allowed, err := s.Authorizer.Allowed(ctx, id, authz.Attributes{Namespace: ns, Group: source.Group(), Resource: source.Resource, Verb: "list"})
				if err != nil {
					checkErr = err
				}
				if !allowed {
					denied = append(denied, fmt.Sprintf("%s: list %s is not authorized; related inventory may be incomplete.", ns, source.Resource))
				}
				return allowed
			}
			items, warnings := s.Workloads.Snapshot(ns, permitted)
			outcomes[i] = outcome{workloads: items, warnings: append(warnings, denied...), err: checkErr}
		})
	}
	wg.Wait()
	for _, o := range outcomes {
		if o.err != nil {
			return nil, o.err
		}
		result.Workloads = append(result.Workloads, o.workloads...)
		result.Warnings = append(result.Warnings, o.warnings...)
	}
	slices.Sort(result.Warnings)
	result.Warnings = slices.Compact(result.Warnings)
	return result, nil
}
