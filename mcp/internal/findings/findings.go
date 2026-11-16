// Package findings reads source reports from driftmower-crawler and matches
// them to the image references workloads run.
package findings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	neturl "net/url"
	"os"
	"strings"

	"github.com/codemowers/driftmower/internal/crawler"
)

// ErrNoInventory means the crawler has nothing to crawl: the cluster serves
// no ContainerImage or SourceRepository, whose CRDs nodestatd installs.
var ErrNoInventory = errors.New("the cluster has no image inventory for the crawler")

// Client fetches the crawler's reports with a projected ServiceAccount token
// for the crawler's audience, reread on every request as the kubelet rotates
// it.
type Client struct {
	URL       string
	TokenFile string
	HTTP      *http.Client
}

// Reports reads the crawler directly. The crawler owns the only report cache.
func (c *Client) Reports(ctx context.Context) ([]crawler.SourceReport, error) {
	return c.reports(ctx, "summary=advisories")
}

// SourceDetails reads release notes only when one source is requested.
func (c *Client) SourceDetails(ctx context.Context, source string) ([]crawler.SourceReport, error) {
	return c.reports(ctx, neturl.Values{"url": {source}}.Encode())
}

func (c *Client) reports(ctx context.Context, query string) ([]crawler.SourceReport, error) {
	var token []byte
	var err error
	if c.TokenFile != "" {
		token, err = os.ReadFile(c.TokenFile)
	}
	if err != nil {
		return nil, fmt.Errorf("read crawler token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.URL, "/")+"/v1/sources?"+query, nil)
	if err != nil {
		return nil, err
	}
	if len(token) > 0 {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("crawler: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Sources []crawler.SourceReport `json:"sources"`
		Missing []string               `json:"missing"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	if len(body.Missing) > 0 {
		return nil, fmt.Errorf("%w: %s not installed; they come with nodestatd", ErrNoInventory, strings.Join(body.Missing, " and "))
	}

	return body.Sources, nil
}

// Changes asks the crawler for the releases of url newer than from, parsed
// at the time of asking. Not cached: a caller asks about one image.
func (c *Client) Changes(ctx context.Context, url, from string) (*crawler.ChangesReport, error) {
	var token []byte
	var err error
	if c.TokenFile != "" {
		token, err = os.ReadFile(c.TokenFile)
	}
	if err != nil {
		return nil, fmt.Errorf("read crawler token: %w", err)
	}
	q := neturl.Values{"url": {url}, "from": {from}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.URL, "/")+"/v1/changes?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if len(token) > 0 {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("crawler: HTTP %d", resp.StatusCode)
	}
	var report crawler.ChangesReport
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		return nil, err
	}
	return &report, nil
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
	keys := Keys(ref)
	if strings.Contains(ref, "@") && len(keys) > 0 {
		keys = keys[:1]
	}
	for _, key := range keys {
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
	explicitTag := false
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name, tag = name[:i], name[i+1:]
		explicitTag = true
	}
	repo := canonicalRepository(name)
	if repo == "" {
		return nil
	}
	var keys []string
	if digest != "" {
		keys = append(keys, repo+"@"+digest)
		if !explicitTag {
			return keys
		}
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
