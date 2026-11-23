package crawler

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// CrawledSource contains upstream evidence only, without deployed versions,
// image names, workload references or an impact calculation.
type CrawledSource struct {
	URL           string             `json:"url"`
	CheckedAt     string             `json:"checkedAt,omitempty"`
	Errors        []string           `json:"errors,omitempty"`
	Unauthorized  bool               `json:"unauthorized,omitempty"`
	License       *RepositoryLicense `json:"license,omitempty"`
	Releases      []Release          `json:"releases,omitempty"`
	Advisories    []Advisory         `json:"advisories,omitempty"`
	ReleaseCount  int                `json:"releaseCount"`
	AdvisoryCount int                `json:"advisoryCount"`
}

func (c *Crawler) CrawledSources(url string) []CrawledSource {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := []CrawledSource{}
	for _, name := range sortedKeys(c.state) {
		if url != "" && name != url {
			continue
		}
		s := c.state[name]
		result := CrawledSource{URL: name, Errors: slices.Clone(s.errors), Unauthorized: s.unauthorized, License: s.license, ReleaseCount: len(s.releases)}
		if url != "" {
			result.Releases = slices.Clone(s.releases)
		}
		if !s.checkedAt.IsZero() {
			result.CheckedAt = s.checkedAt.UTC().Format(time.RFC3339)
		}
		// OSV evidence is fetched for queried revisions/versions, but the MCP
		// response does not advertise which versions this cluster deployed.
		seen := map[string]bool{}
		for _, a := range s.advisories {
			seen[a.ID] = true
			if url != "" {
				result.Advisories = append(result.Advisories, a)
			}
		}
		for _, key := range sortedKeys(s.osv) {
			for _, a := range s.osv[key] {
				if !seen[a.ID] {
					if url != "" {
						result.Advisories = append(result.Advisories, a)
					}
					seen[a.ID] = true
				}
			}
		}
		result.AdvisoryCount = len(seen)
		out = append(out, result)
	}
	return out
}

// MCP serves the crawler's own evidence; it never calls the cluster MCP or
// exposes image/workload inventory. Its caller must authenticate each request.
func (c *Crawler) MCP(version string, authorize func(*http.Request) error) http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "driftmower-crawler", Version: version}, nil)
	type input struct {
		URL string `json:"url,omitempty" jsonschema:"Optional exact repository URL; omitted lists all crawled sources"`
	}
	type output struct {
		Sources []CrawledSource `json:"sources"`
	}
	mcp.AddTool(server, &mcp.Tool{Name: "get_crawled_sources", Description: "List compact cached upstream scrape status, licenses and release/advisory counts. Supply an exact repository URL to include its releases and security advisories. No cluster inventory, deployed-version associations, or live upstream requests.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, func(_ context.Context, _ *mcp.CallToolRequest, in input) (*mcp.CallToolResult, output, error) {
		return nil, output{Sources: c.CrawledSources(in.URL)}, nil
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := authorize(r); err != nil {
			http.Error(w, "unauthorized or forbidden", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})
}
