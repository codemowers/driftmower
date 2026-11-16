package registry

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

type registryCredential struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	Auth          string `json:"auth"`
	IdentityToken string `json:"identitytoken"`
}

func registryHost(repository string) string { host, _, _ := strings.Cut(repository, "/"); return host }
func canonicalRegistryHost(raw string) string {
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Host)
	if host == "registry-1.docker.io" || host == "index.docker.io" {
		return "docker.io"
	}
	return host
}

// Credentials are reread from mounted Secrets on each token exchange. Registry
// scopes never share passwords, and credential helper programs are never run.
func (c *Client) credential(ctx context.Context, host string) (registryCredential, error) {
	if host == "ghcr.io" && c.GitHubTokenFile != "" {
		body, err := os.ReadFile(c.GitHubTokenFile)
		if os.IsNotExist(err) {
			return registryCredential{}, nil
		}
		if err != nil {
			return registryCredential{}, err
		}
		token := strings.TrimSpace(string(body))
		if token == "" {
			return registryCredential{}, errors.New("empty GitHub token")
		}
		username := c.GitHubUsername
		if username == "" {
			fingerprint := sha256.Sum256(body)
			c.mu.Lock()
			if c.githubFingerprint == fingerprint {
				username = c.githubLogin
			}
			c.mu.Unlock()
			if username == "" {
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
				if err != nil {
					return registryCredential{}, err
				}
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("User-Agent", "driftmower-registry-scraper")
				resp, err := c.HTTP.Do(req)
				if err != nil {
					return registryCredential{}, err
				}
				defer resp.Body.Close()
				if resp.StatusCode != 200 {
					return registryCredential{}, errors.New("could not resolve GitHub token owner; configure GHCR_USERNAME")
				}
				var identity struct {
					Login string `json:"login"`
				}
				if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&identity) != nil || identity.Login == "" {
					return registryCredential{}, errors.New("GitHub returned no token owner")
				}
				username = identity.Login
				c.mu.Lock()
				c.githubFingerprint = fingerprint
				c.githubLogin = username
				c.mu.Unlock()
			}
		}
		return registryCredential{Username: username, Password: token}, nil
	}
	if c.CredentialsFile == "" {
		return registryCredential{}, nil
	}
	body, err := os.ReadFile(c.CredentialsFile)
	if os.IsNotExist(err) {
		return registryCredential{}, nil
	}
	if err != nil {
		return registryCredential{}, err
	}
	if len(body) > 1<<20 {
		return registryCredential{}, errors.New("registry credential file exceeds 1 MiB")
	}
	var config struct {
		Auths map[string]registryCredential `json:"auths"`
	}
	if json.Unmarshal(body, &config) != nil {
		return registryCredential{}, errors.New("invalid Docker registry credential JSON")
	}
	for key, cred := range config.Auths {
		if canonicalRegistryHost(key) != host {
			continue
		}
		if cred.Password == "" && cred.Auth != "" {
			raw, err := base64.StdEncoding.DecodeString(cred.Auth)
			if err != nil {
				return registryCredential{}, errors.New("invalid registry auth encoding")
			}
			var ok bool
			cred.Username, cred.Password, ok = strings.Cut(string(raw), ":")
			if !ok {
				return registryCredential{}, errors.New("registry auth needs username:password")
			}
		}
		if cred.IdentityToken != "" && cred.Password == "" {
			return registryCredential{}, errors.New("registry identity tokens are unsupported; use username and access token")
		}
		if cred.Username == "" || cred.Password == "" {
			return registryCredential{}, errors.New("registry credentials need username and access token")
		}
		return cred, nil
	}
	return registryCredential{}, nil
}

func (c *Client) trustedCredentialRealm(repository string, realm *url.URL) bool {
	host := registryHost(repository)
	if c.Endpoint != nil {
		base, _, err := c.endpoint(repository)
		u, _ := url.Parse(base)
		return err == nil && realm.Host == u.Host && realm.Scheme == u.Scheme
	}
	expected := host
	if host == "docker.io" {
		expected = "auth.docker.io"
	}
	return realm.Scheme == "https" && realm.Host == expected
}
