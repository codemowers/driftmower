package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/nonnil"
)

// Alert access maps to Kubernetes permissions of the caller: reading a
// namespace's alerts needs list pods there, silencing them needs create
// alertmanagerconfigs there. Cluster-wide list pods reads every alert,
// including those without a namespace label.

type Alert struct {
	Alertname   string            `json:"alertname"`
	Severity    string            `json:"severity"`
	Namespace   string            `json:"namespace,omitempty"`
	State       string            `json:"state"`
	StartsAt    string            `json:"startsAt"`
	Summary     string            `json:"summary,omitempty"`
	Description string            `json:"description,omitempty"`
	Labels      map[string]string `json:"labels"`
	SilencedBy  []string          `json:"silencedBy"`
	InhibitedBy []string          `json:"inhibitedBy"`
	Fingerprint string            `json:"fingerprint"`
	CanSilence  bool              `json:"canSilence"`
}

type Silence struct {
	ID        string           `json:"id"`
	State     string           `json:"state"`
	Namespace string           `json:"namespace,omitempty"`
	Matchers  []SilenceMatcher `json:"matchers"`
	StartsAt  string           `json:"startsAt"`
	EndsAt    string           `json:"endsAt"`
	CreatedBy string           `json:"createdBy"`
	Comment   string           `json:"comment"`
}

type SilenceMatcher struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	IsRegex bool   `json:"isRegex"`
	IsEqual bool   `json:"isEqual"`
}

type AlertsInput struct {
	Namespace       string `json:"namespace,omitempty"`
	Severity        string `json:"severity,omitempty"`
	IncludeSilenced bool   `json:"includeSilenced,omitempty"`
}

type Alerts struct {
	ObservedAt string         `json:"observedAt"`
	Alerts     []Alert        `json:"alerts"`
	BySeverity map[string]int `json:"bySeverity"`
	Silences   []Silence      `json:"silences"`
	// Alerts left out because the caller may not read their namespace.
	Hidden int      `json:"hidden"`
	Notes  []string `json:"notes"`
}

type SilenceInput struct {
	Namespace       string            `json:"namespace,omitempty"`
	Matchers        map[string]string `json:"matchers,omitempty"`
	DurationMinutes int               `json:"durationMinutes,omitempty"`
	Comment         string            `json:"comment"`
}

type SilenceResult struct {
	ID      string `json:"id"`
	EndsAt  string `json:"endsAt,omitempty"`
	Message string `json:"message"`
}

func (s *Service) AlertsEnabled() bool { return s.AlertmanagerURL != "" }

type alertAccess struct {
	s       *Service
	ctx     context.Context
	id      authz.Identity
	all     *bool
	read    map[string]bool
	silence map[string]bool
}

func (s *Service) access(ctx context.Context, id authz.Identity) *alertAccess {
	return &alertAccess{s: s, ctx: ctx, id: id, read: map[string]bool{}, silence: map[string]bool{}}
}

func (a *alertAccess) readsAll() bool {
	if a.all == nil {
		v := a.s.Judge.MayPerform(a.ctx, a.id, authz.Attributes{Resource: "pods", Verb: "list"}).Verdict == authz.Yes
		a.all = &v
	}

	return *a.all
}

func (a *alertAccess) mayRead(ns string) bool {
	if a.readsAll() {
		return true
	}
	if ns == "" {
		return false
	}
	if v, ok := a.read[ns]; ok {
		return v
	}
	v := a.s.Judge.MayPerform(a.ctx, a.id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}).Verdict == authz.Yes
	a.read[ns] = v

	return v
}

// maySilence asks for create alertmanagerconfigs in ns; an empty ns asks
// cluster-wide.
func (a *alertAccess) maySilence(ns string) bool {
	if v, ok := a.silence[ns]; ok {
		return v
	}
	v := a.s.Judge.MayPerform(a.ctx, a.id, authz.Attributes{Namespace: ns, Group: "monitoring.coreos.com", Resource: "alertmanagerconfigs", Verb: "create"}).Verdict == authz.Yes
	a.silence[ns] = v

	return v
}

type amAlert struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	StartsAt    string            `json:"startsAt"`
	Fingerprint string            `json:"fingerprint"`
	Status      struct {
		State       string   `json:"state"`
		SilencedBy  []string `json:"silencedBy"`
		InhibitedBy []string `json:"inhibitedBy"`
	} `json:"status"`
}

type amSilence struct {
	ID       string           `json:"id"`
	Matchers []SilenceMatcher `json:"matchers"`
	StartsAt string           `json:"startsAt"`
	EndsAt   string           `json:"endsAt"`
	Created  string           `json:"createdBy"`
	Comment  string           `json:"comment"`
	Status   struct {
		State string `json:"state"`
	} `json:"status"`
}

// silenceNamespace is the namespace an exact namespace matcher confines a
// silence to; empty when the silence is not confined.
func silenceNamespace(matchers []SilenceMatcher) string {
	for _, m := range matchers {
		if m.Name == "namespace" && m.IsEqual && !m.IsRegex {
			return m.Value
		}
	}

	return ""
}

func amFilter(name, value string) string { return name + "=" + promString(value) }

// ListAlerts reads firing alerts from Alertmanager, keeping those in
// namespaces the caller may read, and the active or pending silences there.
func (s *Service) ListAlerts(ctx context.Context, id authz.Identity, in AlertsInput) (*Alerts, error) {
	a := s.access(ctx, id)
	if in.Namespace != "" && !a.mayRead(in.Namespace) {
		return nil, fmt.Errorf("Kubernetes RBAC denied list pods in namespace %s, which reading its alerts requires", in.Namespace) //nolint:staticcheck // Kubernetes is a proper noun.
	}
	out := &Alerts{ObservedAt: s.now().UTC().Format(time.RFC3339), Alerts: []Alert{}, BySeverity: map[string]int{}, Silences: []Silence{}, Notes: []string{
		"Alerts are firing alerts from Alertmanager; inhibited alerts are left out, silenced ones only with includeSilenced.",
		"A namespace's alerts are visible with list pods there and silenceable with create alertmanagerconfigs.monitoring.coreos.com there. Cluster-wide list pods shows every alert, including those without a namespace label.",
	}}
	err := func(backend Requester) error {
		u := endpoint(s.AlertmanagerURL, "/api/v2/alerts")
		q := url.Values{"active": {"true"}, "silenced": {fmt.Sprint(in.IncludeSilenced)}, "inhibited": {"false"}, "unprocessed": {"false"}}
		if in.Namespace != "" {
			q.Add("filter", amFilter("namespace", in.Namespace))
		}
		if in.Severity != "" {
			q.Add("filter", amFilter("severity", in.Severity))
		}
		u.RawQuery = q.Encode()
		var alerts []amAlert
		if err := get(ctx, backend, u, "Alertmanager", &alerts); err != nil {
			return err
		}
		for _, al := range alerts {
			ns := al.Labels["namespace"]
			if !a.mayRead(ns) {
				out.Hidden++

				continue
			}
			severity := al.Labels["severity"]
			out.BySeverity[severity]++
			out.Alerts = append(out.Alerts, Alert{
				Alertname: al.Labels["alertname"], Severity: severity, Namespace: ns, State: al.Status.State, StartsAt: al.StartsAt,
				Summary: al.Annotations["summary"], Description: al.Annotations["description"], Labels: al.Labels,
				SilencedBy: nonnil.Slice(al.Status.SilencedBy), InhibitedBy: nonnil.Slice(al.Status.InhibitedBy), Fingerprint: al.Fingerprint,
				CanSilence: a.maySilence(ns),
			})
		}

		var silences []amSilence
		if err := get(ctx, backend, endpoint(s.AlertmanagerURL, "/api/v2/silences"), "Alertmanager", &silences); err != nil {
			return err
		}
		for _, sl := range silences {
			ns := silenceNamespace(sl.Matchers)
			if sl.Status.State == "expired" || !a.mayRead(ns) || (in.Namespace != "" && ns != in.Namespace) {
				continue
			}
			out.Silences = append(out.Silences, Silence{ID: sl.ID, State: sl.Status.State, Namespace: ns, Matchers: sl.Matchers,
				StartsAt: sl.StartsAt, EndsAt: sl.EndsAt, CreatedBy: sl.Created, Comment: sl.Comment})
		}

		return nil
	}(s.Backend)
	if err != nil {
		return nil, err
	}
	rank := map[string]int{"critical": 0, "warning": 1, "info": 2}
	severityRank := func(s string) int {
		if r, ok := rank[s]; ok {
			return r
		}

		return 3
	}
	slices.SortFunc(out.Alerts, func(x, y Alert) int {
		if c := severityRank(x.Severity) - severityRank(y.Severity); c != 0 {
			return c
		}
		if c := strings.Compare(x.Namespace, y.Namespace); c != 0 {
			return c
		}

		return strings.Compare(x.Alertname, y.Alertname)
	})
	slices.SortFunc(out.Silences, func(x, y Silence) int { return strings.Compare(x.EndsAt, y.EndsAt) })

	return out, nil
}

const maxSilence = 7 * 24 * time.Hour

var noRedirects = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// CreateSilence silences alerts matching exact label values, confined to a
// namespace unless the caller may create alertmanagerconfigs cluster-wide.
func (s *Service) CreateSilence(ctx context.Context, id authz.Identity, in SilenceInput) (*SilenceResult, error) {
	a := s.access(ctx, id)
	if strings.TrimSpace(in.Comment) == "" {
		return nil, errors.New("a comment explaining the silence is required")
	}
	if _, ok := in.Matchers["namespace"]; ok {
		return nil, errors.New("set the namespace with the namespace field, not as a matcher")
	}
	if in.Namespace == "" && len(in.Matchers) == 0 {
		return nil, errors.New("a silence without a namespace needs at least one matcher")
	}
	if !a.maySilence(in.Namespace) {
		if in.Namespace == "" {
			return nil, errors.New("Kubernetes RBAC denied cluster-wide create alertmanagerconfigs, which silencing outside a namespace requires") //nolint:staticcheck // Kubernetes is a proper noun.
		}

		return nil, fmt.Errorf("Kubernetes RBAC denied create alertmanagerconfigs in namespace %s, which silencing its alerts requires", in.Namespace) //nolint:staticcheck // Kubernetes is a proper noun.
	}
	duration := time.Duration(in.DurationMinutes) * time.Minute
	if in.DurationMinutes == 0 {
		duration = 2 * time.Hour
	}
	if duration <= 0 || duration > maxSilence {
		return nil, errors.New("durationMinutes must be between 1 and 10080")
	}
	matchers := []SilenceMatcher{}
	if in.Namespace != "" {
		matchers = append(matchers, SilenceMatcher{Name: "namespace", Value: in.Namespace, IsEqual: true})
	}
	for _, name := range slices.Sorted(func(yield func(string) bool) {
		for k := range in.Matchers {
			if !yield(k) {
				return
			}
		}
	}) {
		matchers = append(matchers, SilenceMatcher{Name: name, Value: in.Matchers[name], IsEqual: true})
	}
	now := s.now().UTC()
	body := map[string]any{"matchers": matchers, "startsAt": now.Format(time.RFC3339), "endsAt": now.Add(duration).Format(time.RFC3339),
		"createdBy": id.User, "comment": in.Comment}
	var created struct {
		SilenceID string `json:"silenceID"`
	}
	if err := s.alertmanager(ctx, http.MethodPost, "/api/v2/silences", body, &created); err != nil {
		return nil, err
	}

	return &SilenceResult{ID: created.SilenceID, EndsAt: now.Add(duration).Format(time.RFC3339),
		Message: fmt.Sprintf("Silence %s created until %s.", created.SilenceID, now.Add(duration).Format(time.RFC3339))}, nil
}

// ExpireSilence ends a silence early. The caller needs the same permission
// creating it took: create alertmanagerconfigs in its namespace, or
// cluster-wide for a silence not confined to one.
func (s *Service) ExpireSilence(ctx context.Context, id authz.Identity, silenceID string) (*SilenceResult, error) {
	if silenceID == "" || strings.ContainsAny(silenceID, "/?#") {
		return nil, errors.New("a silence ID is required")
	}
	var current amSilence
	if err := s.alertmanager(ctx, http.MethodGet, "/api/v2/silence/"+url.PathEscape(silenceID), nil, &current); err != nil {
		return nil, err
	}
	ns := silenceNamespace(current.Matchers)
	if !s.access(ctx, id).maySilence(ns) {
		return nil, errors.New("Kubernetes RBAC denies expiring this silence: it needs create alertmanagerconfigs in the silence's namespace, or cluster-wide for a silence without one") //nolint:staticcheck // Kubernetes is a proper noun.
	}
	if current.Status.State == "expired" {
		return &SilenceResult{ID: silenceID, Message: "Silence " + silenceID + " has already expired."}, nil
	}
	if err := s.alertmanager(ctx, http.MethodDelete, "/api/v2/silence/"+url.PathEscape(silenceID), nil, nil); err != nil {
		return nil, err
	}

	return &SilenceResult{ID: silenceID, Message: "Silence " + silenceID + " expired."}, nil
}

// alertmanager sends one request to Alertmanager's v2 API with this
// server's own network access, after the caller's permission was checked.
func (s *Service) alertmanager(ctx context.Context, method, path string, body, into any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	timeout := s.AlertmanagerTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint(s.AlertmanagerURL, path).String(), reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := noRedirects.Do(req)
	if err != nil {
		return fmt.Errorf("Alertmanager is unavailable: %w", err) //nolint:staticcheck // Alertmanager is a proper noun.
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Alertmanager returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))) //nolint:staticcheck // Alertmanager is a proper noun.
	}
	if into == nil {
		return nil
	}

	return json.Unmarshal(raw, into)
}
