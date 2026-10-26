package httpserver

import (
	"log/slog"
	"net/http"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/logging"
	"github.com/codemowers/driftmower-mcp/internal/metrics"
)

// AppOptions configure the main port.
type AppOptions struct {
	PublicURL     string
	Cluster       cluster.Identity
	OAuthClientID string
	MCP           *mcp.Server
	// Nil serves /mcp unauthenticated, for servers not reachable from outside
	// the cluster.
	Auth *auth.Authenticator
	// MCP sessions with no request in flight are closed after this long.
	SessionIdle time.Duration
	// Nil answers /api/cache/invalidate with 404.
	Invalidate http.Handler
	// Links the landing page to /ui.
	WebUI   bool
	Metrics *metrics.Metrics
	Logger  *slog.Logger
}

type app struct {
	opts     AppOptions
	resource string
}

// NewApp returns the handler for the main port: /mcp, the OAuth protected
// resource metadata, the landing page and the cache invalidation webhook.
func NewApp(opts AppOptions) http.Handler {
	a := &app{opts: opts, resource: opts.PublicURL + "/mcp"}

	var mcpHandler http.Handler = mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return opts.MCP },
		&mcp.StreamableHTTPOptions{SessionTimeout: opts.SessionIdle, Logger: logging.AtLeast(opts.Logger, slog.LevelWarn)},
	)

	mux := http.NewServeMux()
	if opts.Auth != nil {
		// Every MCP request is authenticated, and a session belongs to the
		// subject that opened it.
		mcpHandler = opts.Auth.Middleware(opts.PublicURL)(mcpHandler)
		metadata := sdkauth.ProtectedResourceMetadataHandler(opts.Auth.Metadata())
		mux.Handle("/.well-known/oauth-protected-resource", metadata)
		mux.Handle(auth.MetadataPath, metadata)
	}
	mux.Handle("/mcp", mcpHandler)
	mux.HandleFunc("GET /{$}", a.serveLanding)
	if opts.Invalidate != nil {
		mux.Handle(invalidatePath, opts.Invalidate)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
	})

	return opts.Metrics.Instrument(mux)
}
