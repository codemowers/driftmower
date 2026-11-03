// Package findings reads source reports from driftmower-crawler and matches
// them to the image references workloads run.
package findings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/codemowers/driftmower/operator/internal/crawler"
)

const cacheTTL = 30 * time.Second

// Client fetches the crawler's reports with a projected ServiceAccount token
// for the crawler's audience, reread on every request as the kubelet rotates
// it.
type Client struct {
	URL       string
	TokenFile string
	HTTP      *http.Client

	mu      sync.Mutex
	reports []crawler.SourceReport
	fetched time.Time
}

// Reports returns the crawler's current reports, cached briefly.
func (c *Client) Reports(ctx context.Context) ([]crawler.SourceReport, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.fetched) < cacheTTL {
		return c.reports, nil
	}
	token, err := os.ReadFile(c.TokenFile)
	if err != nil {
		return nil, fmt.Errorf("read crawler token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.URL, "/")+"/v1/sources", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("crawler: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Sources []crawler.SourceReport `json:"sources"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	c.reports, c.fetched = body.Sources, time.Now()
	return c.reports, nil
}

// Match is a deployed version of a source an image reference resolves to.
type Match struct {
	Source  *crawler.SourceReport
	Version *crawler.DeployedVersion
}

// Index maps normalized image references to the deployed versions holding
// them.
type Index map[string]Match

func NewIndex(reports []crawler.SourceReport) Index {
	index := Index{}
	for i := range reports {
		report := &reports[i]
		for j := range report.Deployed {
			deployed := &report.Deployed[j]
			for _, ref := range append(append([]string{}, deployed.References...), deployed.Images...) {
				for _, key := range Keys(ref) {
					index[key] = Match{Source: report, Version: deployed}
				}
			}
		}
	}
	return index
}

// Lookup resolves an image reference as a Pod spec carries it.
func (index Index) Lookup(ref string) (Match, bool) {
	for _, key := range Keys(ref) {
		if match, ok := index[key]; ok {
			return match, true
		}
	}
	return Match{}, false
}

// Keys returns the canonical forms of a reference as containerd records
// them: repository:tag, defaulting to latest, and repository@digest when a
// digest is present, with Docker Hub names qualified as
// docker.io/library/<name>. The digest form comes first.
func Keys(ref string) []string {
	name, digest, _ := strings.Cut(strings.TrimSpace(ref), "@")
	tag := "latest"
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name, tag = name[:i], name[i+1:]
	}
	repo := canonicalRepository(name)
	if repo == "" {
		return nil
	}
	var keys []string
	if digest != "" {
		keys = append(keys, repo+"@"+digest)
	}
	return append(keys, repo+":"+tag)
}

func canonicalRepository(name string) string {
	host, path, found := strings.Cut(name, "/")
	if !found || (!strings.ContainsAny(host, ".:") && host != "localhost") {
		host, path = "docker.io", name
	}
	host = strings.ToLower(host)
	if host == "index.docker.io" || host == "registry-1.docker.io" {
		host = "docker.io"
	}
	path = strings.ToLower(strings.Trim(path, "/"))
	if path == "" {
		return ""
	}
	if host == "docker.io" && !strings.Contains(path, "/") {
		path = "library/" + path
	}
	return host + "/" + path
}
