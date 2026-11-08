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
		"Use get_cluster_identity to inspect this identity. A server registration name or kubeconfig context name is only a hint, not proof of cluster identity.",
		"Before using kubectl, compare this API URL with the server URLs in the local kubeconfig. Do not print credentials or use kubectl config view --raw.",
		"For every namespace the user wants to work with, use a separate kubeconfig context named " + id + "/<namespace>, with its context.namespace explicitly set to that namespace. Use the cluster name " + jsonString(c.ID) + " for the kubeconfig cluster entry. Never use a namespace-less context, including for Skaffold; set Skaffold deploy.kubeContext to this exact namespace-qualified context.",
		"Before creating a context, verify the API URL and reuse the intended existing credentials. Create it with kubectl config set-context <cluster>/<namespace> --cluster=<cluster> --user=<verified-user> --namespace=<namespace>. Do not overwrite an existing context that points elsewhere.",
		"Use an explicit --context on every kubectl command that accesses the cluster. If identity is missing, URLs do not match, or the credential choice is ambiguous, ask the user to identify the context or credentials. Multiple namespaces on the same verified cluster are expected. Never assume the current context or switch it implicitly.",
	}
	if c.Authentication == AuthenticationPassmowerOIDC {
		issuer := c.OIDCIssuerURL
		if issuer == "" {
			issuer = "<confirmed OIDC issuer URL>"
		}
		parts = append(parts, "The default/kubelogin Ingress exposes this Kubernetes API via Passmower OIDC. Set up kubectl oidc-login (kubectl krew install oidc-login) with exec apiVersion client.authentication.k8s.io/v1beta1, command kubectl, and arguments oidc-login get-token --oidc-issuer-url="+issuer+" --oidc-client-id=default.kubelogin --oidc-extra-scope=profile,email,groups --listen-address=127.0.0.1:27890. Preserve existing kubeconfig entries and keep credentials out of output.")
	}
	parts = append(parts,
		"Use this connection’s cluster discovery and provisioning tools before planning changes. Verify capabilities and applicable policy bindings before relying on optional resources or defaults.",
		"For general software engineering and platform guidance, use the codemowers MCP server at https://mcp.codemowers.io/mcp.",
		"Live Kubernetes discovery, source findings and dedicated Prometheus drift history describe this cluster. Check coverage warnings before interpreting missing observations.",
	)

	return strings.Join(parts, " ")
}

func jsonString(s *string) string {
	if s == nil {
		return "null"
	}
	b, _ := json.Marshal(*s)

	return string(b)
}
