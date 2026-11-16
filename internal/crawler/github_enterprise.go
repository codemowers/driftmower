package crawler

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Each GitHub API endpoint has its own credentials, conditional cache and
// rate-limit budget. Enterprise tokens never go to GitHub.com or raw URLs.
func (c *Crawler) githubAPIFor(loc location) string {
	if f := c.enterprise[loc.host]; f != nil {
		return f.githubBase
	}
	return githubAPI
}
func (c *Crawler) fetchFor(loc location) *fetcher {
	if f := c.enterprise[loc.host]; f != nil {
		return f
	}
	return c.fetch
}
func enterpriseHTTPClient(host string) *http.Client {
	public := PublicHTTPClient()
	endpoint, _ := url.Parse("https://" + host)
	hostname := endpoint.Hostname()
	transport := public.Transport.(*http.Transport).Clone()
	guarded := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		name, _, err := net.SplitHostPort(address)
		if err == nil && name == hostname {
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, address)
		}
		return guarded(ctx, network, address)
	}
	public.Transport = transport
	public.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "https" || req.URL.Host != host {
			return errors.New("GitHub Enterprise redirect must retain the configured host")
		}
		return nil
	}
	return public
}
func (c *Crawler) locate(raw string) (location, bool) {
	loc, ok := locate(raw, c.cfg.GiteaHosts)
	if ok {
		return loc, true
	}
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Scheme == "https" && parsed.User == nil && c.enterprise[parsed.Host] != nil && strings.Count(strings.Trim(parsed.Path, "/"), "/") == 1 {
		return location{url: raw, host: parsed.Host, path: strings.Trim(parsed.Path, "/"), forge: GitHub}, true
	}
	return loc, false
}

func enterpriseAPI(host string) string {
	if strings.HasSuffix(host, ".ghe.com") {
		return "https://api." + host
	}
	return "https://" + host + "/api/v3"
}
func newEnterpriseFetcher(host, token string) *fetcher {
	base := enterpriseAPI(host)
	parsed, _ := url.Parse(base)
	f := newFetcher(enterpriseHTTPClient(parsed.Host), token)
	f.githubBase = base
	return f
}
