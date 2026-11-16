package mcpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/codemowers/driftmower/internal/httpcache"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
)

// BrowserReads uses the same caller authorization and services as MCP tools,
// with GET semantics so browsers, rather than MCP Pods, retain the JSON.
func BrowserReads(o *observability.Service, w *Workloads, mapping auth.Mapping, histories ...*observability.Service) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Cache-Control", "no-store")
		rw.Header().Set("Vary", "Authorization, Origin")
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			rw.Header().Set("Allow", "GET, POST")
			http.Error(rw, "method not allowed", 405)
			return
		}
		ti := sdkauth.TokenInfoFromContext(r.Context())
		id, err := auth.KubernetesIdentity(auth.CallerFrom(ti), mapping)
		if err != nil {
			http.Error(rw, "authenticated Kubernetes identity required", 403)
			return
		}
		if r.URL.Path == "/api/crawler/authorize" {
			if r.Method != http.MethodGet {
				http.Error(rw, "method not allowed", 405)
				return
			}
			if w == nil || w.Judge.MayPerform(r.Context(), id, authz.Attributes{Group: "codemowers.io", Resource: "containerimages", Verb: "list"}).Verdict != authz.Yes {
				http.Error(rw, "direct crawler reads require list ContainerImages", 403)
				return
			}
			rw.WriteHeader(http.StatusNoContent)
			return
		}
		service := o
		if r.URL.Path == "/api/observability/signal-history" || r.URL.Path == "/api/observability/signal-history-capabilities" {
			service = nil
			if len(histories) > 0 {
				service = histories[0]
			}
			if service == nil && r.URL.Path == "/api/observability/signal-history-capabilities" {
				service = o
			}
		}
		if service == nil {
			http.NotFound(rw, r)
			return
		}
		started := time.Now()
		q := r.URL.Query()
		if r.Method == http.MethodPost {
			var args struct {
				Namespace              string   `json:"namespace"`
				UID                    string   `json:"uid"`
				Pod                    string   `json:"pod"`
				Pods                   []string `json:"pods"`
				Digests                []string `json:"digests"`
				Signal                 string   `json:"signal"`
				Namespaces             []string `json:"namespaces"`
				Days                   int      `json:"days"`
				HoursPerUpgrade        float64  `json:"hoursPerUpgrade"`
				BuildAgeDaysPerUpgrade float64  `json:"buildAgeDaysPerUpgrade"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(rw, r.Body, 8192))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&args); err != nil {
				http.Error(rw, "invalid JSON arguments", 400)
				return
			}
			if err := decoder.Decode(new(any)); err != io.EOF {
				http.Error(rw, "one JSON object is required", 400)
				return
			}
			q.Set("namespace", args.Namespace)
			q.Set("uid", args.UID)
			q.Set("pod", args.Pod)
			q["pods"] = args.Pods
			q["digests"] = args.Digests
			q.Set("signal", args.Signal)
			q["namespaces"] = args.Namespaces
			q.Set("days", strconv.Itoa(args.Days))
			q.Set("hoursPerUpgrade", strconv.FormatFloat(args.HoursPerUpgrade, 'g', -1, 64))
			q.Set("buildAgeDaysPerUpgrade", strconv.FormatFloat(args.BuildAgeDaysPerUpgrade, 'g', -1, 64))
		}
		var body any
		switch r.URL.Path {
		case "/api/observability/signal-history-capabilities":
			body = service.SignalHistoryFeatures()
		case "/api/observability/image-scan-statuses":
			body, err = o.ImageScanStatuses(r.Context(), id, q["digests"])
		case "/api/observability/signal-history":
			var in observability.SignalHistoryInput
			in.Signal = q.Get("signal")
			in.Namespaces = q["namespaces"]
			if q.Get("days") != "" {
				in.Days, err = strconv.Atoi(q.Get("days"))
			}
			if err == nil && q.Get("hoursPerUpgrade") != "" {
				in.HoursPerUpgrade, err = strconv.ParseFloat(q.Get("hoursPerUpgrade"), 64)
			}
			if err == nil && q.Get("buildAgeDaysPerUpgrade") != "" {
				in.BuildAgeDaysPerUpgrade, err = strconv.ParseFloat(q.Get("buildAgeDaysPerUpgrade"), 64)
			}
			if err == nil {
				body, err = service.SignalHistory(r.Context(), id, in)
			}
		case "/api/observability/cluster-health":
			body, err = o.ClusterHealth(r.Context(), id)
		case "/api/observability/alerts":
			body, err = o.ListAlerts(r.Context(), id, observability.AlertsInput{Namespace: q.Get("namespace")})
		case "/api/observability/log-rate":
			if q.Get("namespace") == "" {
				http.Error(rw, "namespace is required", 400)
				return
			}
			body, err = o.LogRate(r.Context(), id, q.Get("namespace"), q.Get("pod"), q["pods"]...)
		case "/api/observability/namespace-resources":
			if q.Get("namespace") == "" {
				http.Error(rw, "namespace is required", 400)
				return
			}
			body, err = o.NamespaceResources(r.Context(), id, q.Get("namespace"))
		case "/api/observability/workload-resources":
			if w == nil {
				http.NotFound(rw, r)
				return
			}
			var pods []string
			_, pods, err = workloadPods(r.Context(), w, id, q.Get("namespace"), q.Get("uid"), q.Get("pod"))
			if err == nil {
				body, err = o.WorkloadUsage(r.Context(), id, q.Get("namespace"), pods)
			}
		default:
			http.NotFound(rw, r)
			return
		}
		if err != nil {
			http.Error(rw, err.Error(), http.StatusBadGateway)
			return
		}
		// No response survives in this process after it is encoded.
		if r.Method == http.MethodGet && r.URL.Path != "/api/observability/signal-history-capabilities" {
			httpcache.Private(rw.Header(), started, time.Now(), ti.Expiration, service.Alignment)
		}
		rw.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(rw).Encode(body)
	})
}
