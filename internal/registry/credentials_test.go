package registry

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRegistryCredentialsStayAtTheirTokenRealm(t *testing.T) {
	for _, registry := range []string{"docker.io", "ghcr.io"} {
		t.Run(registry, func(t *testing.T) {
			tokenCalls := 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/token" {
					tokenCalls++
					user, pass, ok := r.BasicAuth()
					if !ok || user != "fixture" || pass != "secret" {
						t.Error("token exchange has incorrect credentials")
						w.WriteHeader(401)
						return
					}
					registryJSON(w, map[string]any{"token": "scoped-access-token", "expires_in": 3600})
					return
				}
				if strings.HasPrefix(r.Header.Get("Authorization"), "Basic ") {
					t.Error("password reached a registry metadata request")
				}
				if r.Header.Get("Authorization") != "Bearer scoped-access-token" {
					w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fixture"`, server.URL))
					w.WriteHeader(401)
					return
				}
				registryJSON(w, map[string]any{"tags": []string{"1.2.3"}})
			}))
			defer server.Close()
			client := &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }, Status: &RegistryStatusTracker{}}
			file := filepath.Join(t.TempDir(), "credentials")
			if registry == "docker.io" {
				data := jsonBytes(t, map[string]any{"auths": map[string]any{"https://index.docker.io/v1/": map[string]string{"auth": base64.StdEncoding.EncodeToString([]byte("fixture:secret"))}}})
				if err := os.WriteFile(file, data, 0600); err != nil {
					t.Fatal(err)
				}
				client.CredentialsFile = file
			} else {
				if err := os.WriteFile(file, []byte("secret\n"), 0600); err != nil {
					t.Fatal(err)
				}
				client.GitHubTokenFile = file
				client.GitHubUsername = "fixture"
			}
			tags, err := client.Tags(context.Background(), registry+"/example/base")
			if err != nil || len(tags) != 1 || tokenCalls != 1 {
				t.Fatalf("registry read %v %v", tags, err)
			}
			if cred, err := client.credential(context.Background(), "other.example"); err != nil || cred.Password != "" {
				t.Fatal("credentials escaped their registry scope")
			}
			if client.Status.Snapshot(time.Now())[0].Authentication != "authenticated" {
				t.Fatal("authentication status was not recorded")
			}
		})
	}
}

func TestRegistryCredentialsRejectUntrustedRealmBeforeSending(t *testing.T) {
	leaked := false
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer evil.Close()
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fixture"`, evil.URL))
		w.WriteHeader(401)
	}))
	defer registry.Close()
	file := filepath.Join(t.TempDir(), "github-token")
	if err := os.WriteFile(file, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	c := &Client{HTTP: registry.Client(), Endpoint: func(string) string { return registry.URL }, GitHubTokenFile: file, GitHubUsername: "fixture"}
	_, err := c.Tags(context.Background(), "ghcr.io/example/base")
	if err == nil || leaked || strings.Contains(err.Error(), "secret") {
		t.Fatalf("untrusted realm accepted or credentials exposed: %v", err)
	}
}

func TestOptionalCredentialFilesCanAppearAfterStartup(t *testing.T) {
	dir := t.TempDir()
	dockerFile := filepath.Join(dir, "docker.json")
	githubFile := filepath.Join(dir, "github-token")
	client := &Client{CredentialsFile: dockerFile, GitHubTokenFile: githubFile, GitHubUsername: "fixture"}
	for _, host := range []string{"docker.io", "ghcr.io"} {
		cred, err := client.credential(context.Background(), host)
		if err != nil || cred.Username != "" || cred.Password != "" {
			t.Fatalf("missing optional file for %s: %+v %v", host, cred, err)
		}
	}
	if err := os.WriteFile(dockerFile, []byte(`{"auths":{"docker.io":{"username":"fixture","password":"docker-token"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(githubFile, []byte("github-token"), 0600); err != nil {
		t.Fatal(err)
	}
	for host, password := range map[string]string{"docker.io": "docker-token", "ghcr.io": "github-token"} {
		cred, err := client.credential(context.Background(), host)
		if err != nil || cred.Username != "fixture" || cred.Password != password {
			t.Fatalf("new credential not loaded for %s", host)
		}
	}
}
