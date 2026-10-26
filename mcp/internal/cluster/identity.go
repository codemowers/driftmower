// Package cluster describes which Kubernetes cluster this server speaks for.
package cluster

import (
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
