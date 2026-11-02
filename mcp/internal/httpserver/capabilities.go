package httpserver

import (
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/provisioning"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/service"
)

const capabilitiesPath = "/api/provisioning/capabilities"

// Capabilities is a plain JSON view of the capability layer, for
// driftmower-ui and other consumers that are not MCP clients. It uses the
// same authenticator and audience as /mcp, and every per-namespace answer is
// asked of the cluster authorizer as the caller.
type Capabilities struct {
	Service *service.Service
	Mapping auth.Mapping
	// Whether requests arrive authenticated; without it permission verdicts
	// come back unknown rather than refused.
	Authenticated bool
	Logger        *slog.Logger
}

func (c *Capabilities) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		h.Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})

		return
	}

	var identity *authz.Identity
	caller := auth.CallerFrom(sdkauth.TokenInfoFromContext(r.Context()))
	if c.Authenticated {
		id, err := auth.KubernetesIdentity(caller, c.Mapping)
		if err != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "identity_unmappable", "error_description": err.Error()})

			return
		}
		identity = &id
	}

	q := r.URL.Query()
	var namespaces []string
	for ns := range strings.SplitSeq(q.Get("ns"), ",") {
		if ns = strings.TrimSpace(ns); ns != "" && !slices.Contains(namespaces, ns) {
			namespaces = append(namespaces, ns)
		}
	}
	if len(namespaces) > c.Service.MaxNamespaces {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too_many_namespaces",
			"error_description": "At most " + strconv.Itoa(c.Service.MaxNamespaces) + " namespaces per request"})

		return
	}
	// summary drops the raw per-resource matrix (hundreds of cells per
	// namespace) and keeps its counts and every derived verdict.
	detail := q.Get("access")
	if detail == "" {
		detail = "full"
	}
	if detail != "full" && detail != "summary" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown_access_detail", "error_description": "access must be 'full' or 'summary'"})

		return
	}
	offering := q.Get("offering")
	if _, ok := provisioning.OfferingByID(provisioning.OfferingID(offering)); q.Has("offering") && !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown_offering", "error_description": "No offering named " + offering})

		return
	}

	subject := auth.Subject(caller)
	body, err := c.Service.Capabilities(r.Context(), identity, namespaces, provisioning.OfferingID(offering))
	if err != nil {
		var tooMany service.ErrTooManyNamespaces
		if errors.As(err, &tooMany) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too_many_namespaces", "error_description": err.Error()})

			return
		}
		c.Logger.Warn("capabilities failed", "sub", subject, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "kubernetes_unreachable", "error_description": err.Error()})

		return
	}
	c.Logger.Info("capabilities", "sub", subject, "namespaces", namespaces, "offering", offering, "withheld", len(body.Withheld))

	if detail == "summary" {
		for i, f := range body.Namespaces {
			if f.Access != nil {
				access := *f.Access
				access.Matrix = nil
				body.Namespaces[i].Access = &access
			}
		}
	}
	writeJSON(w, http.StatusOK, body)
}
