// Package fakebackend is a stand-in for driftmower-be that answers from
// recorded rows over HTTP.
//
// It is deliberately strict about what it accepts: each service declares the
// same query and select properties as its Feathers schema does, and anything
// else is a 400. A query this fake rejects is one the real backend would
// reject too.
package fakebackend

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// Row is one stored record.
type Row = map[string]any

var queryProperties = map[string][]string{
	"reports": {"id", "sourceType", "status", "clusterContext", "createdAt", "reportHash", "namespaceScope"},
	"image-usages": {"id", "reportId", "workloadGroupKey", "workloadKind", "workloadNamespace", "workloadName", "releaseGroupKey",
		"containerName", "status", "registry", "repository", "deployedTag", "latestTag", "versionStatus", "createdAt"},
	"release-scores": {"reportId", "groupKey"},
}

// Matches the backend's paginate.max: a client asking for more gets this.
const maxPageSize, defaultPageSize = 100, 100

// DefaultToken is the service token the fake accepts unless overridden.
const DefaultToken = "dm_svc_test"

// Backend is a running fake.
type Backend struct {
	URL   string
	Token string

	mu       sync.Mutex
	rows     map[string][]Row
	requests []string
}

// Fixtures loads the recorded rows from test/fixtures/backend.
func Fixtures(t testing.TB) map[string][]Row {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "..", "test", "fixtures", "backend")
	out := map[string][]Row{}
	for service, name := range map[string]string{"reports": "reports.json", "image-usages": "image-usages.json", "release-scores": "release-scores.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		var rows []Row
		if err := json.Unmarshal(raw, &rows); err != nil {
			t.Fatal(err)
		}
		out[service] = rows
	}

	return out
}

// New serves the recorded fixtures, with any services in rows replacing
// theirs.
func New(t testing.TB, rows map[string][]Row) *Backend {
	t.Helper()
	b := &Backend{Token: DefaultToken, rows: Fixtures(t)}
	for k, v := range rows {
		b.rows[k] = v
	}
	srv := httptest.NewServer(http.HandlerFunc(b.serve))
	t.Cleanup(srv.Close)
	b.URL = srv.URL

	return b
}

// SetRows replaces one service's rows.
func (b *Backend) SetRows(service string, rows []Row) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rows[service] = rows
}

// Requests returns every path and decoded query asked for, in order.
func (b *Backend) Requests() []string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return slices.Clone(b.requests)
}

// RequestsTo returns the requests to one service.
func (b *Backend) RequestsTo(service string) []string {
	var out []string
	for _, r := range b.Requests() {
		if strings.HasPrefix(r, "/"+service) {
			out = append(out, r)
		}
	}

	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (b *Backend) serve(w http.ResponseWriter, r *http.Request) {
	decoded, _ := url.QueryUnescape(r.URL.RawQuery)
	request := r.URL.Path
	if decoded != "" {
		request += "?" + decoded
	}
	b.mu.Lock()
	b.requests = append(b.requests, request)
	rows, ok := b.rows[strings.TrimPrefix(r.URL.Path, "/")]
	b.mu.Unlock()

	if r.Header.Get("Authorization") != "Bearer "+b.Token {
		writeJSON(w, 401, map[string]string{"name": "NotAuthenticated", "message": "Invalid service token"})

		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if !ok {
		writeJSON(w, 404, map[string]string{"name": "NotFound", "message": "No service '" + path + "'"})

		return
	}
	body, err := find(path, rows, r.URL.RawQuery)
	if err != nil {
		writeJSON(w, 400, map[string]string{"name": "BadRequest", "message": err.Error()})

		return
	}
	writeJSON(w, 200, body)
}

// queryText is how the backend compares a query value with a stored column.
// A JSON column is stored as its canonical JSON, which a client has to send.
func queryText(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case nil:
		return "null"
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		b, _ := json.Marshal(v)

		return string(b)
	}
}

func sortText(v any) string {
	if v == nil {
		return ""
	}

	return queryText(v)
}

func find(path string, rows []Row, rawQuery string) (any, error) {
	allowed := queryProperties[path]
	check := func(p string) error {
		if allowed != nil && !slices.Contains(allowed, p) {
			return fmt.Errorf("query for '%s' does not allow property '%s'", path, p)
		}

		return nil
	}

	var filters [][2]string
	var selected []string
	selecting := false
	type sortKey struct {
		field string
		dir   int
	}
	var sorts []sortKey
	limit, skip := defaultPageSize, 0

	// Parsed in order, as qs does, so sort priority follows the query.
	for part := range strings.SplitSeq(rawQuery, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		key, _ := url.QueryUnescape(k)
		value, _ := url.QueryUnescape(v)
		switch {
		case strings.HasPrefix(key, "$select[") && strings.HasSuffix(key, "]"):
			if err := check(value); err != nil {
				return nil, err
			}
			selecting = true
			selected = append(selected, value)
		case strings.HasPrefix(key, "$sort[") && strings.HasSuffix(key, "]"):
			field := key[len("$sort[") : len(key)-1]
			if err := check(field); err != nil {
				return nil, err
			}
			dir := 1
			if n, _ := strconv.Atoi(value); n < 0 {
				dir = -1
			}
			sorts = append(sorts, sortKey{field, dir})
		case key == "$limit":
			n, _ := strconv.Atoi(value)
			limit = min(n, maxPageSize)
		case key == "$skip":
			skip, _ = strconv.Atoi(value)
		default:
			if err := check(key); err != nil {
				return nil, err
			}
			filters = append(filters, [2]string{key, value})
		}
	}

	var matched []Row
	for _, row := range rows {
		if !slices.ContainsFunc(filters, func(f [2]string) bool { return queryText(row[f[0]]) != f[1] }) {
			matched = append(matched, row)
		}
	}
	sorted := slices.Clone(matched)
	slices.SortStableFunc(sorted, func(a, b Row) int {
		for _, s := range sorts {
			if c := strings.Compare(sortText(a[s.field]), sortText(b[s.field])); c != 0 {
				return c * s.dir
			}
		}

		return 0
	})
	start, end := min(skip, len(sorted)), min(skip+limit, len(sorted))
	page := sorted[start:end]
	data := make([]Row, 0, len(page))
	for _, row := range page {
		if !selecting {
			data = append(data, row)

			continue
		}
		// The backend builds the response from the selected properties only,
		// so an unselected field — id included — is absent.
		projected := Row{}
		for _, f := range selected {
			if v, ok := row[f]; ok {
				projected[f] = v
			}
		}
		data = append(data, projected)
	}

	return map[string]any{"total": len(matched), "limit": limit, "skip": skip, "data": data}, nil
}
