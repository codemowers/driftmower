package httpserver

import (
	_ "embed"
	"encoding/json"
	"html/template"
	"net/http"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/cluster"
)

//go:embed landing.html
var landingSource string

var landingTemplate = template.Must(template.New("landing").Parse(landingSource))

type landingPage struct {
	Authenticated  bool
	ClientID       string
	ClusterID      string
	APIURL         string
	Claude         string
	Codex          string
	CodexProject   string
	OpenCode       string
	OpenCodeGlobal string
	OpenCodeAuth   string
	MCPJSON        string
	OtherClients   string
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func jsonText(v any) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)

	return strings.TrimSuffix(b.String(), "\n")
}

func newLandingPage(authenticated bool, endpoint, clientID string, c cluster.Identity) landingPage {
	name := c.MCPServerName
	withClient := authenticated && clientID != ""

	claude := "claude mcp add --transport http --scope user"
	if withClient {
		claude += " --client-id " + shellQuote(clientID)
	}
	claude += " " + name + " " + shellQuote(endpoint)

	codex := "codex mcp add " + name + " --url " + shellQuote(endpoint)
	if withClient {
		codex += " --oauth-client-id " + shellQuote(clientID)
	}

	server := map[string]any{"type": "http", "url": endpoint}
	if withClient {
		server["oauth"] = map[string]string{"clientId": clientID}
	}

	openCode := "opencode mcp add " + shellQuote(name) + " --url " + shellQuote(endpoint)
	if withClient {
		openCode += "\n\ntmp=$(mktemp ./opencode.json.XXXXXX) &&\n" +
			"jq --arg name " + shellQuote(name) + " --arg client " + shellQuote(clientID) +
			" '.mcp.servers[$name].oauth |= ((. // {}) + {client_id: $client})' opencode.json > \"$tmp\" &&\n" +
			"mv \"$tmp\" opencode.json"
	}
	// The same merge into the user-level configuration.
	openCodeGlobal := ""
	if withClient {
		openCodeGlobal = "config=\"${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json\"\n\n" +
			"jq --arg name " + shellQuote(name) + " --arg client " + shellQuote(clientID) + " \\\n" +
			"   '.mcp.servers[$name].oauth |= ((. // {}) + {client_id: $client})' \\\n" +
			"   \"$config\" > \"$config.part\" &&\n" +
			"mv \"$config.part\" \"$config\""
	}

	quotedName := jsonText(name)
	codexProject := "[mcp_servers." + quotedName + "]\nurl = " + jsonText(endpoint) + "\n\n" +
		"[mcp_servers." + quotedName + ".oauth]\nclient_id = " + jsonText(clientID) + "\n" +
		"callback_port = 33418\ncallback_url = \"http://127.0.0.1:33418/callback\""

	other := "Transport: Streamable HTTP\nURL: " + endpoint
	if withClient {
		other += "\nOAuth client ID: " + clientID
	}

	page := landingPage{
		Authenticated:  authenticated,
		ClientID:       clientID,
		ClusterID:      "Not configured",
		APIURL:         "Not configured — confirm the target context before using kubectl",
		Claude:         claude,
		Codex:          codex,
		CodexProject:   codexProject,
		OpenCode:       openCode,
		OpenCodeGlobal: openCodeGlobal,
		OpenCodeAuth:   "opencode mcp auth " + shellQuote(name),
		MCPJSON:        jsonText(map[string]any{"mcpServers": map[string]any{name: server}}),
		OtherClients:   other,
	}
	if c.ID != nil {
		page.ClusterID = *c.ID
	}
	if c.APIURL != nil {
		page.APIURL = *c.APIURL
	}

	return page
}

func (a *app) serveLanding(w http.ResponseWriter, r *http.Request) {
	endpoint := a.resource
	if a.opts.Auth == nil {
		endpoint = "http://" + r.Host + "/mcp"
	}
	page := newLandingPage(a.opts.Auth != nil, endpoint, a.opts.OAuthClientID, a.opts.Cluster)

	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodHead {
		return
	}
	if err := landingTemplate.Execute(w, page); err != nil {
		a.opts.Logger.Error("render landing page", "error", err)
	}
}
