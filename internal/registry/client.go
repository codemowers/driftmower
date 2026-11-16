package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxMetadataBytes = 8 << 20
const manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

type UnsupportedManifestError struct{ Schema int }

func (e *UnsupportedManifestError) Error() string {
	return fmt.Sprintf("unsupported Docker manifest schema %d", e.Schema)
}

type HTTPError struct {
	Status     int
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	if e.RetryAfter <= 0 {
		return fmt.Sprintf("registry HTTP %d", e.Status)
	}
	return fmt.Sprintf("registry HTTP %d (retry after %s)", e.Status, e.RetryAfter)
}
func registryHTTPError(resp *http.Response) *HTTPError {
	delay := time.Duration(0)
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
		delay = time.Duration(min(seconds, 86400)) * time.Second
	} else if date, err := http.ParseTime(resp.Header.Get("Retry-After")); err == nil {
		delay = max(0, min(time.Until(date), 24*time.Hour))
	}
	if delay <= 0 && resp.StatusCode == http.StatusTooManyRequests {
		delay = 15 * time.Minute
	}
	return &HTTPError{resp.StatusCode, delay}
}

type registryToken struct {
	value   string
	expires time.Time
}

type Client struct {
	HTTP            *http.Client
	CredentialsFile string
	GitHubTokenFile string
	GitHubUsername  string
	Status          *RegistryStatusTracker
	// Endpoint is overridden by tests; production always uses HTTPS.
	Endpoint          func(host string) string
	mu                sync.Mutex
	tokens            map[string]registryToken
	githubFingerprint [32]byte
	githubLogin       string
}

func (c *Client) endpoint(repository string) (string, string, error) {
	if !repositoryPattern.MatchString(repository) {
		return "", "", fmt.Errorf("invalid fully qualified repository %q", repository)
	}
	host, name, _ := strings.Cut(repository, "/")
	if host == "docker.io" {
		host = "registry-1.docker.io"
	}
	base := "https://" + host
	if c.Endpoint != nil {
		base = c.Endpoint(host)
	}
	return base, name, nil
}

func (c *Client) get(ctx context.Context, target, tokenKey, scope string) ([]byte, http.Header, error) {
	host := registryHost(tokenKey)
	if c.Status != nil {
		if err := c.Status.Blocked(host, time.Now()); err != nil {
			return nil, nil, err
		}
	}
	c.mu.Lock()
	token := c.tokens[tokenKey]
	c.mu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("Accept", manifestAccept)
		req.Header.Set("User-Agent", "driftmower-registry-scraper (+https://github.com/codemowers/driftmower)")
		if token.expires.After(time.Now()) {
			req.Header.Set("Authorization", "Bearer "+token.value)
		}
		resp, err := c.HTTP.Do(req)
		if c.Status != nil {
			c.Status.Request(host, resp, err, time.Now(), false)
		}
		if err != nil {
			return nil, nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			challenge := resp.Header.Get("WWW-Authenticate")
			resp.Body.Close()
			token, err = c.authorize(ctx, challenge, scope, tokenKey)
			if err != nil {
				return nil, nil, err
			}
			c.mu.Lock()
			if c.tokens == nil {
				c.tokens = map[string]registryToken{}
			}
			c.tokens[tokenKey] = token
			c.mu.Unlock()
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadataBytes+1))
		resp.Body.Close()
		if err != nil {
			return nil, nil, err
		}
		if len(body) > maxMetadataBytes {
			return nil, nil, errors.New("registry metadata exceeds 8 MiB")
		}
		if resp.StatusCode != http.StatusOK {
			return nil, nil, registryHTTPError(resp)
		}
		return body, resp.Header, nil
	}
	return nil, nil, errors.New("registry authentication failed")
}

var challengeParameter = regexp.MustCompile(`([a-zA-Z_]+)="([^"\r\n]*)"`)
var tagReferencePattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$`)

func (c *Client) authorize(ctx context.Context, challenge, scope, repository string) (registryToken, error) {
	if c.Status != nil {
		if err := c.Status.Blocked(registryHost(repository), time.Now()); err != nil {
			return registryToken{}, err
		}
	}
	if !strings.HasPrefix(strings.ToLower(challenge), "bearer ") {
		return registryToken{}, errors.New("registry does not offer anonymous bearer authentication")
	}
	params := map[string]string{}
	for _, m := range challengeParameter.FindAllStringSubmatch(challenge, -1) {
		params[strings.ToLower(m[1])] = m[2]
	}
	u, err := url.Parse(params["realm"])
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && c.Endpoint == nil) {
		return registryToken{}, errors.New("invalid registry token realm")
	}
	query := u.Query()
	query.Set("service", params["service"])
	query.Set("scope", scope)
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return registryToken{}, err
	}
	cred, err := c.credential(ctx, registryHost(repository))
	if err != nil {
		return registryToken{}, err
	}
	if cred.Password != "" {
		if !c.trustedCredentialRealm(repository, u) {
			return registryToken{}, errors.New("registry requested credentials at an untrusted token realm")
		}
		req.SetBasicAuth(cred.Username, cred.Password)
	}
	resp, err := c.HTTP.Do(req)
	if c.Status != nil {
		c.Status.Request(registryHost(repository), resp, err, time.Now(), true)
	}
	if err != nil {
		return registryToken{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return registryToken{}, registryHTTPError(resp)
	}
	var result struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return registryToken{}, err
	}
	if result.Token == "" {
		result.Token = result.AccessToken
	}
	if result.Token == "" {
		return registryToken{}, errors.New("empty registry token")
	}
	if c.Status != nil {
		c.Status.Authenticated(registryHost(repository), cred.Password != "")
	}
	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 60
	}
	return registryToken{result.Token, time.Now().Add(time.Duration(result.ExpiresIn) * time.Second * 9 / 10)}, nil
}

func (c *Client) Tags(ctx context.Context, repository string) ([]string, error) {
	base, name, err := c.endpoint(repository)
	if err != nil {
		return nil, err
	}
	next := base + "/v2/" + name + "/tags/list?n=1000"
	seen := map[string]bool{}
	var tags []string
	for pages := 0; next != ""; pages++ {
		if pages >= 1000 || seen[next] {
			return nil, errors.New("registry tag pagination exceeded bound or looped")
		}
		seen[next] = true
		body, headers, err := c.get(ctx, next, repository, "repository:"+name+":pull")
		if err != nil {
			return nil, err
		}
		var result struct {
			Tags []string `json:"tags"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		tags = append(tags, result.Tags...)
		current, _ := url.Parse(next)
		next = ""
		for _, link := range headers.Values("Link") {
			for _, part := range strings.Split(link, ",") {
				if !strings.Contains(part, `rel="next"`) && !strings.Contains(part, "rel=next") {
					continue
				}
				start, end := strings.Index(part, "<"), strings.Index(part, ">")
				if start < 0 || end <= start {
					return nil, errors.New("invalid registry pagination link")
				}
				ref, err := url.Parse(part[start+1 : end])
				if err != nil {
					return nil, err
				}
				target := current.ResolveReference(ref)
				if target.Scheme != current.Scheme || target.Host != current.Host || target.User != nil || target.Path != current.Path {
					return nil, errors.New("registry pagination changed origin or repository")
				}
				next = target.String()
			}
		}
	}
	slices.Sort(tags)
	return slices.Compact(tags), nil
}

func (c *Client) Fetch(ctx context.Context, repository, kind, reference string) ([]byte, string, error) {
	base, name, err := c.endpoint(repository)
	if err != nil {
		return nil, "", err
	}
	if kind != "manifests" && kind != "blobs" {
		return nil, "", errors.New("invalid registry object kind")
	}
	if !digestPattern.MatchString(reference) && (kind != "manifests" || !tagReferencePattern.MatchString(reference)) {
		return nil, "", errors.New("invalid registry object reference")
	}
	body, headers, err := c.get(ctx, base+"/v2/"+name+"/"+kind+"/"+reference, repository, "repository:"+name+":pull")
	if err != nil {
		return nil, "", err
	}
	// Schema-1 signatures have a different digest domain (the JWS payload).
	// We do not index that legacy format: it has no OCI config/DiffID chain.
	if kind == "manifests" {
		var header struct {
			SchemaVersion int `json:"schemaVersion"`
		}
		if json.Unmarshal(body, &header) == nil && header.SchemaVersion == 1 {
			return nil, "", &UnsupportedManifestError{Schema: 1}
		}
	}
	digest := headers.Get("Docker-Content-Digest")
	if digestPattern.MatchString(reference) {
		digest = reference
	}
	if digest == "" {
		sum := sha256Digest(body)
		digest = sum
	}
	if err := VerifyDigest(digest, body); err != nil {
		return nil, "", err
	}
	return body, digest, nil
}
