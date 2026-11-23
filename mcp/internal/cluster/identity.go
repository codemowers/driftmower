// Package cluster describes which Kubernetes cluster this server speaks for.
package cluster

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

// Identity names the cluster this MCP connection exposes. ID and APIURL are
// nil when neither configuration nor discovery established them.
type Identity struct {
	ID             *string `json:"id"`
	APIURL         *string `json:"apiUrl"`
	MCPServerName  string  `json:"mcpServerName"`
	Authentication string  `json:"authentication,omitempty"`
	OIDCIssuerURL  string  `json:"oidcIssuerUrl,omitempty"`
}

// AuthenticationPassmowerOIDC marks a cluster whose API is published through
// the default/kubelogin Ingress.
const AuthenticationPassmowerOIDC = "passmower-oidc"

var serverNameUnsafe = regexp.MustCompile(`[^a-z0-9_-]+`)

// NewIdentity derives the MCP server name from the cluster ID, falling back to
// the public URL's host. The full domain keeps providers with identical region
// names distinct.
func NewIdentity(id, apiURL *string, publicURL string) Identity {
	suffix := ""
	if id != nil {
		suffix = *id
	} else if parsed, err := url.Parse(publicURL); err == nil {
		suffix = parsed.Host
	}
	suffix = serverNameUnsafe.ReplaceAllString(strings.ToLower(suffix), "-")

	return Identity{ID: id, APIURL: apiURL, MCPServerName: "driftmower-" + suffix}
}

// Instructions tell an agent how to select a kubectl context for this
// cluster, without trusting registration or context names.
func Instructions(c Identity) string {
	id := "<cluster>"
	if c.ID != nil {
		id = *c.ID
	}
	parts := []string{
		"This MCP connection identifies cluster " + jsonString(c.ID) + "; its external Kubernetes API URL is " + jsonString(c.APIURL) + ".",
		"Match that URL against local kubeconfig servers before using kubectl; context names are only hints. Use a context named " + id + "/<namespace> with its namespace set, pass --context explicitly, and never switch the current context. Ask when the match is ambiguous.",
	}
	if c.Authentication == AuthenticationPassmowerOIDC {
		issuer := c.OIDCIssuerURL
		if issuer == "" {
			issuer = "<confirmed OIDC issuer URL>"
		}
		parts = append(parts, "Authenticate with kubectl oidc-login get-token --oidc-issuer-url="+issuer+" --oidc-client-id=default.kubelogin --oidc-extra-scope=profile,email,groups --listen-address=127.0.0.1:27890.")
	}
	parts = append(parts, "For general engineering guidance use https://mcp.codemowers.io/mcp.")

	return strings.Join(parts, " ")
}

func jsonString(s *string) string {
	if s == nil {
		return "null"
	}
	b, _ := json.Marshal(*s)

	return string(b)
}
