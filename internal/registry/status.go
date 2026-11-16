package registry

import (
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type RegistryStatus struct {
	Registry            string    `json:"registry"`
	State               string    `json:"state"`
	ActiveRepositories  []string  `json:"activeRepositories"`
	Authentication      string    `json:"authentication"`
	RetryAt             time.Time `json:"retryAt,omitzero"`
	LastRequest         time.Time `json:"lastRequest,omitzero"`
	LastSuccess         time.Time `json:"lastSuccess,omitzero"`
	LastError           string    `json:"lastError,omitempty"`
	LastHTTPStatus      int       `json:"lastHTTPStatus,omitempty"`
	requests            map[int]uint64
	successes, failures uint64
}
type registryProgress struct {
	RegistryStatus
	active        map[string]bool
	backoffStatus int
}
type RegistryStatusTracker struct {
	mu    sync.Mutex
	hosts map[string]*registryProgress
}

func (t *RegistryStatusTracker) host(host string) *registryProgress {
	if t.hosts == nil {
		t.hosts = map[string]*registryProgress{}
	}
	h := t.hosts[host]
	if h == nil {
		h = &registryProgress{RegistryStatus: RegistryStatus{Registry: host, Authentication: "anonymous", requests: map[int]uint64{}}, active: map[string]bool{}}
		t.hosts[host] = h
	}
	return h
}
func (t *RegistryStatusTracker) Configure(repos []RepositoryConfig) {
	t.mu.Lock()
	defer t.mu.Unlock()
	keep := map[string]bool{}
	for _, repo := range repos {
		host := registryHost(repo.Repository)
		keep[host] = true
		t.host(host)
	}
	for host, h := range t.hosts {
		if !keep[host] && len(h.active) == 0 {
			delete(t.hosts, host)
		}
	}
}
func (t *RegistryStatusTracker) Start(repo string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.host(registryHost(repo)).active[repo] = true
}
func (t *RegistryStatusTracker) Finish(repo string, errors []string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.host(registryHost(repo))
	delete(h.active, repo)
	if len(errors) > 0 {
		h.failures++
		h.LastError = errors[len(errors)-1]
	} else {
		h.successes++
		h.LastSuccess = now
		if !h.RetryAt.After(now) {
			h.LastError = ""
		}
	}
}
func (t *RegistryStatusTracker) Authenticated(host string, authenticated bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.host(host)
	if authenticated {
		h.Authentication = "authenticated"
	} else {
		h.Authentication = "anonymous"
	}
}
func (t *RegistryStatusTracker) Request(host string, resp *http.Response, err error, now time.Time, authentication bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.host(host)
	h.LastRequest = now
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	h.requests[status]++
	h.LastHTTPStatus = status
	if err != nil {
		h.LastError = err.Error()
		return
	}
	if status == 401 && !authentication {
		return
	} // An ordinary bearer challenge.
	if status >= 400 {
		upstream := registryHTTPError(resp)
		h.LastError = upstream.Error()
		delay := upstream.RetryAfter
		if delay <= 0 && (status >= 500 || status == 401 || status == 403) {
			delay = time.Minute
		}
		if delay > 0 {
			until := now.Add(delay)
			if until.After(h.RetryAt) {
				h.RetryAt = until
				h.backoffStatus = status
			}
		}
	} else if !h.RetryAt.After(now) {
		h.LastError = ""
	}
}
func (t *RegistryStatusTracker) Blocked(host string, now time.Time) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.host(host)
	if h.RetryAt.After(now) {
		return &HTTPError{Status: h.backoffStatus, RetryAfter: h.RetryAt.Sub(now)}
	}
	return nil
}
func (t *RegistryStatusTracker) Snapshot(now time.Time) []RegistryStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := []RegistryStatus{}
	for _, h := range t.hosts {
		s := h.RegistryStatus
		s.State = "idle"
		s.ActiveRepositories = []string{}
		for repo := range h.active {
			s.ActiveRepositories = append(s.ActiveRepositories, repo)
		}
		slices.Sort(s.ActiveRepositories)
		if len(h.active) > 0 {
			s.State = "scraping"
		}
		if h.RetryAt.After(now) && h.backoffStatus == 429 {
			s.State = "throttled"
		}
		s.requests = map[int]uint64{}
		for code, count := range h.requests {
			s.requests[code] = count
		}
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b RegistryStatus) int { return strings.Compare(a.Registry, b.Registry) })
	return out
}

var registryMetricDescs = map[string]*prometheus.Desc{
	"state":    prometheus.NewDesc("driftmower_registry_state", "Current registry scheduler state; one-hot idle, scraping or throttled.", []string{"registry", "state"}, nil),
	"active":   prometheus.NewDesc("driftmower_registry_scrapes_active", "Repositories currently being scraped.", []string{"registry"}, nil),
	"retry":    prometheus.NewDesc("driftmower_registry_backoff_until_timestamp_seconds", "Registry-wide backoff deadline; zero when no backoff is active.", []string{"registry"}, nil),
	"request":  prometheus.NewDesc("driftmower_registry_last_request_timestamp_seconds", "Latest upstream request; zero before the first request.", []string{"registry"}, nil),
	"success":  prometheus.NewDesc("driftmower_registry_last_success_timestamp_seconds", "Latest successfully completed repository scrape; zero before success.", []string{"registry"}, nil),
	"requests": prometheus.NewDesc("driftmower_registry_requests_total", "Upstream registry requests by HTTP status; 0 indicates a transport error.", []string{"registry", "status_code"}, nil),
	"scrapes":  prometheus.NewDesc("driftmower_registry_scrapes_total", "Completed repository scrapes by result.", []string{"registry", "result"}, nil),
}

func (t *RegistryStatusTracker) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range registryMetricDescs {
		ch <- d
	}
}
func (t *RegistryStatusTracker) Collect(ch chan<- prometheus.Metric) {
	now := time.Now()
	timestamp := func(t time.Time) float64 {
		if t.IsZero() {
			return 0
		}
		return float64(t.Unix())
	}
	for _, s := range t.Snapshot(now) {
		for _, state := range []string{"idle", "scraping", "throttled"} {
			v := 0.
			if s.State == state {
				v = 1
			}
			ch <- prometheus.MustNewConstMetric(registryMetricDescs["state"], prometheus.GaugeValue, v, s.Registry, state)
		}
		values := map[string]float64{"active": float64(len(s.ActiveRepositories)), "request": timestamp(s.LastRequest), "success": timestamp(s.LastSuccess), "retry": 0}
		if s.RetryAt.After(now) {
			values["retry"] = timestamp(s.RetryAt)
		}
		for name, v := range values {
			ch <- prometheus.MustNewConstMetric(registryMetricDescs[name], prometheus.GaugeValue, v, s.Registry)
		}
		for code, count := range s.requests {
			ch <- prometheus.MustNewConstMetric(registryMetricDescs["requests"], prometheus.CounterValue, float64(count), s.Registry, strconv.Itoa(code))
		}
		ch <- prometheus.MustNewConstMetric(registryMetricDescs["scrapes"], prometheus.CounterValue, float64(s.successes), s.Registry, "success")
		ch <- prometheus.MustNewConstMetric(registryMetricDescs["scrapes"], prometheus.CounterValue, float64(s.failures), s.Registry, "error")
	}
}
