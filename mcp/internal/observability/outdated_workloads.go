package observability

import (
	"context"
	"errors"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type OutdatedWorkloadsInput struct {
	Namespaces []string `json:"namespaces,omitempty"`
}
type OutdatedWorkload struct {
	UID            string  `json:"uid"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	Namespace      string  `json:"namespace"`
	CurrentTag     string  `json:"currentTag"`
	LatestTag      string  `json:"latestTag"`
	Class          string  `json:"class"`
	ReleasesBehind float64 `json:"releasesBehind"`
}
type OutdatedWorkloads struct {
	Available  bool               `json:"available"`
	ObservedAt int64              `json:"observedAt"`
	Entries    []OutdatedWorkload `json:"entries"`
	Warnings   []string           `json:"warnings"`
}

func outdatedExpression(selector string) string {
	labels := "namespace,uid,kind,workload,image,version,latest"
	behind := `max by (` + labels + `) (driftmower_version_releases_behind{` + selector + `} > 0)`
	classes := `max by (` + labels + `,class) (driftmower_version_drift{` + joinSelector(selector, `class=~"major|minor|patch|behind"`) + `} > 0)`
	// Rank observed release counts in Prometheus, retaining the worst image of
	// each workload and its exact version/class labels. No browser risk scores.
	return `topk(5, topk by (namespace,uid) (1, ` + behind + ` * on (` + labels + `) group_left (class) ` + classes + `)) or label_replace(max(driftmower_version_drift{` + selector + `}),"signal","coverage","","")`
}
func (s *Service) OutdatedWorkloads(ctx context.Context, id authz.Identity, in OutdatedWorkloadsInput) (*OutdatedWorkloads, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("history Prometheus is not configured")
	}
	if len(in.Namespaces) > 500 {
		return nil, errors.New("too many namespaces")
	}
	namespaces := slices.Clone(in.Namespaces)
	slices.Sort(namespaces)
	namespaces = slices.Compact(namespaces)
	parts := []string{}
	scopes := namespaces
	if len(scopes) == 0 {
		scopes = []string{""}
	}
	for _, ns := range namespaces {
		if !namespacePattern.MatchString(ns) {
			return nil, errors.New("invalid namespace")
		}
		parts = append(parts, regexp.QuoteMeta(ns))
	}
	for _, ns := range scopes {
		if err := s.require(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}, "Kubernetes RBAC denied reading workload drift in the requested scope"); err != nil {
			return nil, err
		}
	}
	selector := ""
	if len(parts) > 0 {
		selector = "namespace=~" + promString(strings.Join(parts, "|"))
	}
	at := s.now().Truncate(5 * time.Minute)
	u := endpoint(s.PrometheusURL, "/api/v1/query")
	q := u.Query()
	q.Set("query", outdatedExpression(selector))
	q.Set("time", strconv.FormatInt(at.Unix(), 10))
	q.Set("limit", "7")
	u.RawQuery = q.Encode()
	var response promResponse
	if err := get(ctx, s.Backend, u, "Prometheus outdated workloads", &response); err != nil {
		return nil, err
	}
	if err := response.check("vector"); err != nil {
		return nil, err
	}
	if len(response.Data.Result) > 6 {
		return nil, errors.New("outdated workload response exceeded limit")
	}
	out := &OutdatedWorkloads{ObservedAt: at.Unix(), Entries: []OutdatedWorkload{}, Warnings: slices.Clone(response.Warnings)}
	if out.Warnings == nil {
		out.Warnings = []string{}
	}
	seen := map[string]bool{}
	for _, row := range response.Data.Result {
		if row.Metric["signal"] == "coverage" {
			if len(row.Metric) != 1 || row.Value == nil || row.Value.Value != "1" {
				return nil, errors.New("invalid drift coverage observation")
			}
			out.Available = true
			continue
		}
		m := row.Metric
		if len(namespaces) > 0 && !slices.Contains(namespaces, m["namespace"]) {
			return nil, errors.New("prometheus returned a workload outside the requested namespace")
		}
		if row.Value == nil || m["uid"] == "" || m["workload"] == "" || !slices.Contains([]string{"major", "minor", "patch", "behind"}, m["class"]) {
			return nil, errors.New("invalid workload drift observation")
		}
		value, err := strconv.ParseFloat(row.Value.Value, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
			return nil, errors.New("invalid release count")
		}
		key := m["namespace"] + "/" + m["uid"]
		if seen[key] {
			return nil, errors.New("duplicate workload drift observation")
		}
		seen[key] = true
		out.Entries = append(out.Entries, OutdatedWorkload{UID: m["uid"], Kind: m["kind"], Name: m["workload"], Namespace: m["namespace"], CurrentTag: m["version"], LatestTag: m["latest"], Class: m["class"], ReleasesBehind: value})
	}
	slices.SortFunc(out.Entries, func(a, b OutdatedWorkload) int {
		if a.ReleasesBehind > b.ReleasesBehind {
			return -1
		}
		if a.ReleasesBehind < b.ReleasesBehind {
			return 1
		}
		return strings.Compare(a.Namespace+"/"+a.Name, b.Namespace+"/"+b.Name)
	})
	return out, nil
}
