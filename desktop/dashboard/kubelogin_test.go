package dashboard

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func idToken(t *testing.T, exp time.Time) string {
	t.Helper()
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"https://auth.example","aud":"kubelogin","exp":` + strconv.FormatInt(exp.Unix(), 10) + `}`))

	return "e30." + payload + ".sig"
}

// fakeKubectl installs a kubectl that answers `oidc-login get-token` the way
// kubelogin does, recording its arguments and environment.
func fakeKubectl(t *testing.T, token string) (dir string, record string) {
	t.Helper()
	dir = t.TempDir()
	record = filepath.Join(dir, "record")
	script := "#!/bin/sh\necho \"$@\" > " + record + "\necho \"$KUBERNETES_EXEC_INFO $EXTRA\" >> " + record +
		"\necho \"$DRIFTMOWER_BROWSER_PROFILE $DRIFTMOWER_OPEN_AUTH_URL\" >> " + record +
		"\necho '{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{\"token\":\"" + token + "\"}}'\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	return dir, record
}

func oidcUser() *clientcmdapi.AuthInfo {
	return &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{
		APIVersion: "client.authentication.k8s.io/v1", Command: "kubectl",
		Args: []string{"oidc-login", "get-token", "--oidc-issuer-url=https://auth.example", "--oidc-client-id=kubelogin"},
		Env:  []clientcmdapi.ExecEnvVar{{Name: "EXTRA", Value: "from-kubeconfig"}},
	}}
}

func TestRunOIDCLoginRunsTheKubeconfigPluginAsKubectlWould(t *testing.T) {
	token := idToken(t, time.Now().Add(time.Hour))
	dir, record := fakeKubectl(t, token)
	t.Setenv("PATH", dir)
	got, err := runOIDCLogin(context.Background(), oidcUser())
	if err != nil {
		t.Fatal(err)
	}
	if got != token {
		t.Fatalf("token = %q", got)
	}
	seen, _ := os.ReadFile(record)
	for _, want := range []string{"oidc-login get-token --oidc-issuer-url=https://auth.example --oidc-client-id=kubelogin", `"kind":"ExecCredential"`, "from-kubeconfig"} {
		if !strings.Contains(string(seen), want) {
			t.Errorf("plugin saw %q, missing %q", seen, want)
		}
	}
}

func TestRunOIDCLoginRefusesOtherPlugins(t *testing.T) {
	user := &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: "aws", Args: []string{"eks", "get-token"}}}
	if _, err := runOIDCLogin(context.Background(), user); err == nil {
		t.Fatal("ran a plugin other than kubelogin")
	}
}

func TestSignedInTokenReplacesThePlugin(t *testing.T) {
	token := idToken(t, time.Now().Add(time.Hour))
	user := oidcUser()
	if err := StaticCredentials(user, time.Now(), func(key string) string {
		if key != "https://auth.example kubelogin" {
			t.Errorf("key = %q", key)
		}

		return token
	}); err != nil {
		t.Fatal(err)
	}
	if user.Exec != nil || user.Token != token {
		t.Fatalf("user = %+v", user)
	}
}

func TestSignInAcceptsOnlyTheLoopbackPage(t *testing.T) {
	for _, tc := range []struct {
		host, origin, contentType string
		ok                        bool
	}{
		{"localhost:17843", "http://localhost:17843", "application/json", true},
		{"127.0.0.1:17843", "http://127.0.0.1:17843", "application/json", true},
		{"localhost:17843", "https://evil.example", "application/json", false},
		{"evil.example:8080", "http://evil.example:8080", "application/json", false},
		{"localhost:17843", "http://localhost:17843", "text/plain", false},
	} {
		r := httptest.NewRequest("POST", "/api/kubernetes-sign-in", nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Content-Type", tc.contentType)
		if got := sameOriginLoopback(r); got != tc.ok {
			t.Errorf("%+v: admitted = %v", tc, got)
		}
	}
}
