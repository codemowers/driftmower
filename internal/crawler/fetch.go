package crawler

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/codemowers/driftmower/internal/gzipstore"
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
var errUnauthorized = errors.New("unauthorized")
var errResponseTooLarge = errors.New("response too large")

// fetcher makes conditional GET requests, reusing a cached body on 304, and
// paces GitHub requests by the rate limit GitHub reports.
type fetcher struct {
	validate    func([]byte) error
	cacheDir    string
	bodyLimit   int64
	client      *http.Client
	githubToken string
	githubBase  string
	metrics     *fetchMetrics

	mu        sync.Mutex
	cache     map[string]cachedResponse
	remaining int
	reset     time.Time
}

type cachedResponse struct {
	checkedAt          time.Time
	etag, lastModified string
	body               []byte
}

func newFetcher(client *http.Client, githubToken string) *fetcher {
	return &fetcher{client: client, githubToken: githubToken, githubBase: githubAPI, metrics: newFetchMetrics(), cache: map[string]cachedResponse{}, remaining: -1}
}

// getJSON fetches url and decodes it into out. It returns errNotFound for 404.
func (f *fetcher) getJSON(ctx context.Context, url string, out any) (err error) {
	observe := f.observeFetch(url)
	defer func() { observe(err) }()
	body, err := f.get(ctx, url, false)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// getRaw fetches a file's contents as they are, such as a changelog.
func (f *fetcher) getRaw(ctx context.Context, url string) (body []byte, err error) {
	observe := f.observeFetch(url)
	defer func() { observe(err) }()
	return f.get(ctx, url, true)
}

func (f *fetcher) get(ctx context.Context, url string, raw bool) ([]byte, error) {
	base := f.githubBase
	if base == "" {
		base = githubAPI
	}
	github := strings.HasPrefix(url, base+"/")
	if github {
		if err := f.waitGitHub(ctx); err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Accept", "application/json")
	if raw {
		req.Header.Set("Accept", "*/*")
	}
	if github {
		req.Header.Set("Accept", "application/vnd.github+json")
		if raw {
			req.Header.Set("Accept", "application/vnd.github.raw")
		}
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		if f.githubToken != "" {
			req.Header.Set("Authorization", "Bearer "+f.githubToken)
		}
	}
	cacheKey := url
	if raw {
		cacheKey += "#representation=raw"
	}
	f.mu.Lock()
	cached, hasCache := f.cache[cacheKey]
	f.mu.Unlock()
	if f.cacheDir != "" {
		cached, hasCache, err = f.diskResponse(cacheKey, f.limit())
		if errors.Is(err, errInvalidHTTPCache) {
			cached = cachedResponse{}
			hasCache = false
		} else if err != nil {
			return nil, fmt.Errorf("read HTTP cache: %w", err)
		}
	}
	if hasCache {
		if cached.etag != "" {
			req.Header.Set("If-None-Match", cached.etag)
		}
		if cached.lastModified != "" {
			req.Header.Set("If-Modified-Since", cached.lastModified)
		}
	}
	resp, err := f.client.Do(req)
	f.observeHTTP(url, resp)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if github {
		f.recordGitHub(resp.Header)
	}
	body, compressed, err := f.responseBody(url, resp)
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusNotModified && hasCache:
		body = cached.body
		if f.cacheDir != "" {
			if err := f.touchResponse(cacheKey, cached); err != nil {
				return nil, err
			}
		}
	case resp.StatusCode == http.StatusNotFound:
		return nil, errNotFound
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, fmt.Errorf("%s: HTTP %d: %w", url, resp.StatusCode, errUnauthorized)
	case resp.StatusCode == http.StatusForbidden:
		// GitHub also uses 403 for rate limits; those are retryable failures,
		// not evidence that this token lacks repository access.
		var response struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(bytes.NewReader(body)).Decode(&response)
		limited := resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != "" || strings.Contains(strings.ToLower(response.Message), "rate limit")
		if limited {
			return nil, fmt.Errorf("%s: HTTP %d (rate limited)", url, resp.StatusCode)
		}
		return nil, fmt.Errorf("%s: HTTP %d: %w", url, resp.StatusCode, errUnauthorized)
	case resp.StatusCode == http.StatusOK:
		if f.validate != nil {
			if err := f.validate(body); err != nil {
				return nil, err
			}
		}
		etag, modified := resp.Header.Get("ETag"), resp.Header.Get("Last-Modified")
		if f.cacheDir != "" {
			if err := f.persistResponse(cacheKey, compressed, body, etag, modified); err != nil {
				return nil, fmt.Errorf("persist HTTP cache: %w", err)
			}
		} else if etag != "" || modified != "" {
			f.mu.Lock()
			f.cache[cacheKey] = cachedResponse{etag: etag, lastModified: modified, body: body}
			f.mu.Unlock()
		}
	default:
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return body, nil
}

func (f *fetcher) postJSON(ctx context.Context, url string, in, out any) (err error) {
	observe := f.observeFetch(url)
	defer func() { observe(err) }()
	data, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	f.observeHTTP(url, resp)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, compressed, err := f.responseBody(url, resp)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	if f.cacheDir != "" {
		key := url + "#" + cacheID(string(data))
		if err := f.persistResponse(key, compressed, body, resp.Header.Get("ETag"), resp.Header.Get("Last-Modified")); err != nil {
			return err
		}
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

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

func (f *fetcher) limit() int64 {
	if f.bodyLimit > 0 {
		return f.bodyLimit
	}
	return maxBody
}

// Explicit Accept-Encoding disables Go's automatic decompression: measure and
// persist the wire representation, decoding only a separate reader for parsing.
func (f *fetcher) responseBody(raw string, resp *http.Response) ([]byte, []byte, error) {
	limit := f.limit()
	wire, err := io.ReadAll(io.LimitReader(resp.Body, limit+(1<<20)+1))
	encoding := resp.Header.Get("Content-Encoding")
	if encoding == "" {
		encoding = "identity"
	}
	if f.metrics != nil {
		f.metrics.downloads.WithLabelValues(downloadCategory(raw), responseHostname(raw, resp), downloadEncoding(encoding)).Observe(float64(len(wire)))
	}
	if err != nil {
		return nil, nil, err
	}
	if int64(len(wire)) > limit+(1<<20) {
		return nil, nil, errResponseTooLarge
	}
	if resp.StatusCode == http.StatusNotModified {
		return nil, nil, nil
	}
	if encoding == "gzip" {
		// Decode checks both the uncompressed limit and the gzip checksum.
		body, err := gzipstore.Decode(wire, limit)
		return body, wire, err
	}
	if encoding != "identity" {
		return nil, nil, fmt.Errorf("unsupported content encoding %q", encoding)
	}
	if int64(len(wire)) > limit {
		return nil, nil, errResponseTooLarge
	}
	if resp.StatusCode != http.StatusOK {
		return wire, nil, nil
	}
	var out bytes.Buffer
	z := gzip.NewWriter(&out)
	if _, err = z.Write(wire); err != nil {
		return nil, nil, err
	}
	if err = z.Close(); err != nil {
		return nil, nil, err
	}
	return wire, out.Bytes(), nil
}
