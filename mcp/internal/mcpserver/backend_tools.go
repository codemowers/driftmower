package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/mcp/internal/backend"
)

// Backend enables the report-backed tools.
type Backend struct {
	Searcher *backend.Searcher
	Planner  *backend.Planner
	Tenancy  *Tenancy
}

type searchInput struct {
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}

type planInput struct {
	Namespace       string   `json:"namespace,omitempty"`
	VersionStatuses []string `json:"versionStatuses,omitempty"`
	Limit           int      `json:"limit,omitempty"`
	Cursor          string   `json:"cursor,omitempty"`
}

// How many matches the text summary names before counting the rest; the full
// list is in structuredContent.
const namedInSummary = 5

func addBackendTools(s *mcp.Server, b *Backend) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "search_workloads",
		Title: "Search Driftmower workloads",
		Description: "Search workload names in the latest backend Driftmower report snapshots. Use for report-backed drift investigation or finding candidates for image-update planning. " +
			"Results may be stale or differently scoped from this MCP cluster; inspect snapshot scope and freshness. For what runs now and its resource relationships, prefer get_workloads when available.",
		InputSchema: inputSchema[searchInput](func(p map[string]*jsonschema.Schema) {
			p["query"].MinLength = jsonschema.Ptr(1)
			p["limit"].Minimum = jsonschema.Ptr(1.0)
		}),
		OutputSchema: schemaFor[*backend.SearchResult](),
		Annotations:  readOnly("Search Driftmower workloads"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in searchInput) (*mcp.CallToolResult, *backend.SearchResult, error) {
		result, err := b.Searcher.Search(ctx, in.Query, in.Limit, b.Tenancy.resolveScope(ctx, req))
		if err != nil {
			return nil, nil, err
		}

		return text(summarizeSearch(result)), result, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "plan_image_updates",
		Title: "Plan Driftmower image updates",
		Description: "Use to propose image-tag and Helm-chart updates from the latest ready Driftmower backend snapshot. Advisory only: does not modify workloads or deploy updates. " +
			"Inspect snapshot scope, warnings, manual-review actions and nextCursor before presenting a complete plan; verify candidates against live inventory when available.",
		InputSchema: inputSchema[planInput](func(p map[string]*jsonschema.Schema) {
			p["namespace"].MinLength = jsonschema.Ptr(1)
			statuses := p["versionStatuses"]
			statuses.Types, statuses.Type = nil, "array"
			statuses.MinItems, statuses.UniqueItems = jsonschema.Ptr(1), true
			statuses.Items.Enum = enumOf(backend.ActionableStatuses)
			p["limit"].Minimum = jsonschema.Ptr(1.0)
			p["cursor"].MinLength = jsonschema.Ptr(1)
		}),
		OutputSchema: schemaFor[*backend.Plan](),
		Annotations:  readOnly("Plan Driftmower image updates"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in planInput) (*mcp.CallToolResult, *backend.Plan, error) {
		// The scope comes from the verified token, never from the input: a
		// tool argument is caller-controlled and would widen access.
		plan, err := b.Planner.Plan(ctx, backend.PlanInput{Namespace: in.Namespace, VersionStatuses: in.VersionStatuses, Limit: in.Limit, Cursor: in.Cursor},
			b.Tenancy.resolveScope(ctx, req))
		if err != nil {
			return nil, nil, err
		}

		return text(summarizePlan(plan)), plan, nil
	})
}

func summarizeSearch(r *backend.SearchResult) string {
	if len(r.Matches) == 0 {
		return "No workloads match `" + r.Query + "`." + r.Scope.Suffix()
	}
	var named []string
	for _, m := range r.Matches[:min(len(r.Matches), namedInSummary)] {
		namespace, name := "unknown", m.WorkloadID
		if m.Namespace != nil {
			namespace = *m.Namespace
		}
		if m.Name != nil {
			name = *m.Name
		}
		named = append(named, namespace+"/"+name)
	}
	more := ""
	if rest := len(r.Matches) - len(named); rest > 0 {
		more = fmt.Sprintf(" and %d more", rest)
	}

	return fmt.Sprintf("%d workload(s) match `%s`: %s%s.%s", len(r.Matches), r.Query, strings.Join(named, ", "), more, r.Scope.Suffix())
}

func summarizePlan(p *backend.Plan) string {
	if p.Status == "no_ready_report" {
		return "No ready Driftmower snapshot, so no update plan could be built."
	}
	s := p.Summary
	parts := []string{fmt.Sprintf("%d advisory action(s) from %d image candidate(s): %d image tag update(s), %d Helm chart update(s), %d needing manual review.",
		s.TotalActions, s.UniqueImageCandidates, s.ImageTagUpdates, s.HelmChartUpdates, s.ManualReviews)}
	if p.NextCursor != nil {
		parts = append(parts, "More actions remain; pass `cursor` to continue.")
	}
	if len(p.Warnings) > 0 {
		parts = append(parts, fmt.Sprintf("%d warning(s): %s", len(p.Warnings), strings.Join(p.Warnings, "; ")))
	}

	return strings.Join(parts, " ") + p.Scope.Suffix()
}
