package crawler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	UserAgent    = "driftmower-crawler (+https://github.com/codemowers/driftmower)"
	maxBody      = 8 << 20
	githubAPI    = "https://api.github.com"
	githubMargin = 2
)

var errNotFound = errors.New("not found")

// fetcher makes conditional GET requests, reusing a cached body on 304, and
// paces GitHub requests by the rate limit GitHub reports.
type fetcher struct {
	client      *http.Client
	githubToken string

	mu        sync.Mutex
	cache     map[string]cachedResponse
	remaining int
	reset     time.Time
}

type cachedResponse struct {
	etag, lastModified string
	body               []byte
}

func newFetcher(client *http.Client, githubToken string) *fetcher {
	return &fetcher{client: client, githubToken: githubToken, cache: map[string]cachedResponse{}, remaining: -1}
}

// getJSON fetches url and decodes it into out. It returns errNotFound for 404.
func (f *fetcher) getJSON(ctx context.Context, url string, out any) error {
	github := strings.HasPrefix(url, githubAPI+"/")
	if github {
		if err := f.waitGitHub(ctx); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept", "application/json")
	if github {
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		if f.githubToken != "" {
			req.Header.Set("Authorization", "Bearer "+f.githubToken)
		}
	}
	f.mu.Lock()
	cached, hasCache := f.cache[url]
	f.mu.Unlock()
	if hasCache {
		if cached.etag != "" {
			req.Header.Set("If-None-Match", cached.etag)
		}
		if cached.lastModified != "" {
			req.Header.Set("If-Modified-Since", cached.lastModified)
		}
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if github {
		f.recordGitHub(resp.Header)
	}
	var body []byte
	switch {
	case resp.StatusCode == http.StatusNotModified && hasCache:
		body = cached.body
	case resp.StatusCode == http.StatusNotFound:
		return errNotFound
	case resp.StatusCode == http.StatusOK:
		if body, err = io.ReadAll(io.LimitReader(resp.Body, maxBody+1)); err != nil {
			return err
		}
		if len(body) > maxBody {
			return fmt.Errorf("%s: response too large", url)
		}
		if etag, modified := resp.Header.Get("ETag"), resp.Header.Get("Last-Modified"); etag != "" || modified != "" {
			f.mu.Lock()
			f.cache[url] = cachedResponse{etag: etag, lastModified: modified, body: body}
			f.mu.Unlock()
		}
	default:
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

// postJSON sends in as JSON and decodes the response into out.
func (f *fetcher) postJSON(ctx context.Context, url string, in, out any) error {
	data, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(out)
}

// waitGitHub blocks until the rate limit allows another request.
func (f *fetcher) waitGitHub(ctx context.Context) error {
	f.mu.Lock()
	remaining, reset := f.remaining, f.reset
	f.mu.Unlock()
	if remaining < 0 || remaining > githubMargin || time.Now().After(reset) {
		return nil
	}
	timer := time.NewTimer(time.Until(reset) + time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (f *fetcher) recordGitHub(header http.Header) {
	remaining, err1 := strconv.Atoi(header.Get("X-RateLimit-Remaining"))
	reset, err2 := strconv.ParseInt(header.Get("X-RateLimit-Reset"), 10, 64)
	if err1 != nil || err2 != nil {
		return
	}
	f.mu.Lock()
	f.remaining, f.reset = remaining, time.Unix(reset, 0)
	f.mu.Unlock()
}

// RateLimit reports GitHub's last reported remaining requests and reset time.
func (f *fetcher) RateLimit() (int, time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.remaining, f.reset
}

// PublicHTTPClient reaches only public addresses over HTTPS redirects, so a
// source URL or redirect cannot reach cluster or host services.
func PublicHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if ip == nil || !publicIP(ip) {
			return fmt.Errorf("address %s is not public", host)
		}
		return nil
	}}
	transport := &http.Transport{DialContext: dialer.DialContext, Proxy: nil, TLSHandshakeTimeout: 10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second, MaxIdleConns: 10, IdleConnTimeout: 90 * time.Second}
	return &http.Client{Transport: transport, Timeout: time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "https" {
			return errors.New("redirect must use https")
		}
		return nil
	}}
}

var sharedAddressSpace = net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func publicIP(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !sharedAddressSpace.Contains(ip)
}
