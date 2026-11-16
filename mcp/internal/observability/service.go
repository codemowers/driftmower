package observability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/kubernetes"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// Service answers observability questions as a verified caller. Every
// permission is asked of the cluster authorizer before a backend is queried.
type Service struct {
	// Empty disables the metrics and resource-usage tools.
	PrometheusURL     string
	ScannerNamespace  string
	ScannerInstance   string
	CVEHistoryEnabled bool
	SAHistoryEnabled  bool
	// Prometheus's public address for links; empty reads its
	// web.external-url flag.
	PrometheusExternalURL string
	// Optional bound for dedicated history stores; resource monitoring defaults to seven days.
	MaxHistoryRange time.Duration
	// Empty reads logs from the Kubernetes API instead.
	LokiURL string
	// Empty disables the alert tools.
	AlertmanagerURL     string
	AlertmanagerTimeout time.Duration
	// Offers query_logs; set when observability is configured.
	LogsEnabled bool
	// The shared gateway to Prometheus and Loki.
	Backend Requester
	// Reads PVCs, PVs and pod logs with this server's own credentials, after
	// the caller's permission is checked.
	Kubernetes kubernetes.Interface
	Judge      authz.Judge
	// Marks claims the caller may expand; set when expand_volume is offered.
	ExpandEnabled bool
	// Resource-usage evaluation times are aligned down to this, so refreshes
	// ask Prometheus the identical question and share an answer.
	Alignment time.Duration
	Now       func() time.Time

	external struct {
		sync.Mutex
		url *string
	}
}

func (s *Service) MetricsEnabled() bool { return s.PrometheusURL != "" }

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}

	return time.Now()
}

func (s *Service) require(ctx context.Context, id authz.Identity, attrs authz.Attributes, denied string) error {
	if s.Judge.MayPerform(ctx, id, attrs).Verdict != authz.Yes {
		return errors.New(denied)
	}

	return nil
}

func endpoint(base, path string) *url.URL {
	u, _ := url.Parse(strings.TrimRight(base, "/") + path)

	return u
}

// PublicURL is Prometheus's public address for links to its graphs, or nil.
func (s *Service) PublicURL(ctx context.Context) *string {
	if s.PrometheusURL == "" {
		return nil
	}

	return s.externalURL(ctx, s.Backend)
}

// externalURL is Prometheus's public address: PrometheusExternalURL, else its
// web.external-url flag, which prometheus-operator sets from
// spec.externalUrl. A successful answer is kept; nil when Prometheus
// advertises no http(s) address.
func (s *Service) externalURL(ctx context.Context, backend Requester) *string {
	if s.PrometheusExternalURL != "" {
		public := strings.TrimRight(s.PrometheusExternalURL, "/")

		return &public
	}
	s.external.Lock()
	defer s.external.Unlock()
	if s.external.url == nil {
		var resp struct {
			Status string            `json:"status"`
			Data   map[string]string `json:"data"`
		}
		if err := get(ctx, backend, endpoint(s.PrometheusURL, "/api/v1/status/flags"), "Prometheus", &resp); err != nil || resp.Status != "success" {
			return nil
		}
		public := ""
		if u, err := url.Parse(resp.Data["web.external-url"]); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
			public = strings.TrimRight(u.String(), "/")
		}
		s.external.url = &public
	}
	if *s.external.url == "" {
		return nil
	}

	return s.external.url
}

// get queries a backend and decodes a 200 answer.
func get(ctx context.Context, backend Requester, u *url.URL, name string, into any) error {
	resp, err := backend.Get(ctx, u)
	if err != nil {
		return err
	}
	if resp.Status != 200 {
		return fmt.Errorf("%s returned HTTP %d", name, resp.Status)
	}
	if err := json.Unmarshal(resp.Body, into); err != nil {
		return fmt.Errorf("%s returned an unreadable response: %w", name, err)
	}

	return nil
}

// promString quotes a label value as PromQL and LogQL expect.
func promString(s string) string {
	b, _ := json.Marshal(s)

	return string(b)
}

func validateRange(start, end time.Time) error {
	if !end.After(start) || end.Sub(start) > 7*24*time.Hour {
		return errors.New("time range must be positive and at most seven days")
	}

	return nil
}

// PromSample is a Prometheus [timestamp, "value"] pair.
type PromSample struct {
	Time  float64
	Value string
}

func (s *PromSample) UnmarshalJSON(b []byte) error {
	var pair []json.RawMessage
	if err := json.Unmarshal(b, &pair); err != nil || len(pair) != 2 {
		return errors.New("malformed sample")
	}
	if err := json.Unmarshal(pair[0], &s.Time); err != nil {
		return err
	}

	return json.Unmarshal(pair[1], &s.Value)
}

func (s PromSample) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{s.Time, s.Value})
}

type promSeries struct {
	Metric     map[string]string `json:"metric"`
	Value      *PromSample       `json:"value,omitempty"`
	Values     []PromSample      `json:"values,omitempty"`
	Histogram  any               `json:"histogram,omitempty"`
	Histograms any               `json:"histograms,omitempty"`
}

type promResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string       `json:"resultType"`
		Result     []promSeries `json:"result"`
	} `json:"data"`
	Warnings []string `json:"warnings"`
	Infos    []string `json:"infos"`
}

func (r *promResponse) check(resultType string) error {
	if r.Status != "success" {
		return errors.New("Prometheus query did not succeed") //nolint:staticcheck // Prometheus is a proper noun.
	}
	if resultType != "" && r.Data.ResultType != resultType {
		return fmt.Errorf("Prometheus returned a %s result, expected %s", r.Data.ResultType, resultType) //nolint:staticcheck // Prometheus is a proper noun.
	}

	return nil
}
