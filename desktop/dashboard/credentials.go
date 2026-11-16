package dashboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// A context works when its kubeconfig carries a client certificate or token;
// when it uses kubelogin (`oidc-login get-token`) and kubelogin's cache holds
// an unexpired ID token, which discovery reads without running kubelogin; or
// when it uses AWS or Azure credential plugins, which discovery runs because
// they never prompt. Other plugins are not run.
var (
	ErrExecUnsupported = errors.New("credential plugin unsupported; use a client certificate, cached OIDC login, or AWS or Azure CLI credentials")
	ErrOIDCNotCached   = errors.New("no unexpired cached OIDC token; run kubectl on the host to sign in")
)

// StaticCredentials replaces an oidc-login exec user with its cached ID token,
// or with signedIn's token for the same issuer and client when that is still
// valid.
func StaticCredentials(auth *clientcmdapi.AuthInfo, now time.Time, signedIn func(key string) string) error {
	if auth == nil {
		return nil
	}
	if auth.AuthProvider != nil {
		return ErrExecUnsupported
	}
	if auth.Exec == nil {
		return nil
	}
	if _, ok := cloudPlugin(auth.Exec); ok {
		return cloudCredentials(auth, now)
	}
	flags, ok := oidcLoginFlags(auth.Exec)
	if !ok || flags["oidc-issuer-url"] == "" || flags["oidc-client-id"] == "" {
		return ErrExecUnsupported
	}
	if signedIn != nil {
		if token := signedIn(loginKey(auth)); token != "" {
			if claims, ok := jwtClaims(token); ok && claims.Expiry > now.Add(30*time.Second).Unix() {
				auth.Exec = nil
				auth.Token = token

				return nil
			}
		}
	}
	dir := flags["token-cache-dir"]
	if dir == "" {
		dir = "~/.kube/cache/oidc-login"
	}
	if rest, found := strings.CutPrefix(dir, "~"); found {
		home, err := os.UserHomeDir()
		if err != nil {
			return ErrOIDCNotCached
		}
		dir = filepath.Join(home, rest)
	}
	token := cachedIDToken(dir, flags["oidc-issuer-url"], flags["oidc-client-id"], now)
	if token == "" {
		return ErrOIDCNotCached
	}
	auth.Exec = nil
	auth.Token = token
	return nil
}

func oidcLoginFlags(exec *clientcmdapi.ExecConfig) (map[string]string, bool) {
	args := exec.Args
	switch path.Base(exec.Command) {
	case "kubectl":
		if len(args) == 0 || args[0] != "oidc-login" {
			return nil, false
		}
		args = args[1:]
	case "kubectl-oidc_login", "kubelogin":
	default:
		return nil, false
	}
	if len(args) == 0 || args[0] != "get-token" {
		return nil, false
	}
	flags := map[string]string{}
	for i := 1; i < len(args); i++ {
		name, found := strings.CutPrefix(args[i], "--")
		if !found {
			continue
		}
		if key, value, ok := strings.Cut(name, "="); ok {
			flags[key] = value
		} else if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
			flags[name] = args[i+1]
			i++
		}
	}
	// Azure and int128 both ship a binary named kubelogin. Only int128's
	// invocation carries OIDC issuer/client flags; Azure must keep its own args.
	return flags, flags["oidc-issuer-url"] != "" && flags["oidc-client-id"] != ""
}

func cachedIDToken(dir, issuer, clientID string, now time.Time) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	best, bestExp := "", int64(0)
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), ".lock") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var cached struct {
			IDToken string `json:"id_token"`
		}
		if json.Unmarshal(data, &cached) != nil || cached.IDToken == "" {
			continue
		}
		claims, ok := jwtClaims(cached.IDToken)
		if !ok || strings.TrimRight(claims.Issuer, "/") != strings.TrimRight(issuer, "/") || !claims.Audience.contains(clientID) {
			continue
		}
		if claims.Expiry > now.Add(30*time.Second).Unix() && claims.Expiry > bestExp {
			best, bestExp = cached.IDToken, claims.Expiry
		}
	}
	return best
}

type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*a = audience{one}
		return nil
	}
	return json.Unmarshal(b, (*[]string)(a))
}

func (a audience) contains(v string) bool {
	for _, s := range a {
		if s == v {
			return true
		}
	}
	return false
}

type idTokenClaims struct {
	Issuer   string   `json:"iss"`
	Audience audience `json:"aud"`
	Expiry   int64    `json:"exp"`
}

func jwtClaims(token string) (idTokenClaims, bool) {
	var claims idTokenClaims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, false
	}
	return claims, json.Unmarshal(payload, &claims) == nil
}
