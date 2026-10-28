// Package backend reads persisted Driftmower analysis from driftmower-be: report
// snapshots, image usages and Helm release scores. It searches workloads and
// plans image updates from them, confined to the caller's namespace scope.
package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Client speaks driftmower-be's Feathers REST API. It is the only place that
// knows the query syntax ($limit, $skip, $sort, $select), the paginated
// envelope and the service-token credential.
type Client struct {
	BaseURL string
	Token   string
	Timeout time.Duration
	// Rows per page; defaults to 100.
	PageSize int
	HTTP     *http.Client
}

// Query is a Feathers query in the bracketed form the backend's qs parser
// reads: $sort[createdAt]=-1, $select[0]=id. Parameters keep their order,
// which for $sort is the sort priority.
type Query []queryParam

type queryParam struct{ key, value string }

// Set replaces key's value, or appends it.
func (q Query) Set(key, value string) Query {
	for i := range q {
		if q[i].key == key {
			out := slices.Clone(q)
			out[i].value = value

			return out
		}
	}

	return append(slices.Clone(q), queryParam{key, value})
}

func (q Query) Select(fields ...string) Query {
	for i, f := range fields {
		q = q.Set("$select["+strconv.Itoa(i)+"]", f)
	}

	return q
}

// Sort adds a sort key after any earlier ones; direction is 1 or -1.
func (q Query) Sort(field string, direction int) Query {
	return q.Set("$sort["+field+"]", strconv.Itoa(direction))
}

// Encode keeps parameter order.
func (q Query) Encode() string {
	parts := make([]string, len(q))
	for i, p := range q {
		parts[i] = url.QueryEscape(p.key) + "=" + url.QueryEscape(p.value)
	}

	return strings.Join(parts, "&")
}

// RequestError reports a failed backend call; Status is 0 when none arrived.
type RequestError struct {
	Message string
	Status  int
}

func (e *RequestError) Error() string { return e.Message }

type page[T any] struct {
	Total int `json:"total"`
	Data  []T `json:"data"`
}

// findPage reads one page. Bare-array responses (paginate: false) are
// normalised to the envelope.
func findPage[T any](ctx context.Context, c *Client, path string, q Query) (page[T], error) {
	u := strings.TrimRight(c.BaseURL, "/") + "/" + path
	if encoded := q.Encode(); encoded != "" {
		u += "?" + encoded
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return page[T]{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return page[T]{}, &RequestError{Message: fmt.Sprintf("Request to %s failed: %v", u, err)}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return page[T]{}, &RequestError{Message: fmt.Sprintf("Request to %s failed: %v", u, err)}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		text := string(body)
		if len(text) > 500 {
			text = text[:500]
		}
		if text == "" {
			text = http.StatusText(resp.StatusCode)
		}

		return page[T]{}, &RequestError{Message: fmt.Sprintf("Request to %s failed with %d: %s", u, resp.StatusCode, text), Status: resp.StatusCode}
	}

	var bare []T
	if json.Unmarshal(body, &bare) == nil {
		return page[T]{Total: len(bare), Data: bare}, nil
	}
	var p page[T]
	if err := json.Unmarshal(body, &p); err != nil {
		return page[T]{}, &RequestError{Message: fmt.Sprintf("Response from %s was not JSON: %v", u, err)}
	}
	if p.Data == nil {
		var probe struct {
			Data json.RawMessage `json:"data"`
		}
		_ = json.Unmarshal(body, &probe)
		if string(probe.Data) != "[]" {
			return page[T]{}, &RequestError{Message: "Unexpected response shape from " + u}
		}
	}

	return p, nil
}

// errPageLimit is returned when a full read would need more than maxPages.
var errPageLimit = errors.New("page limit reached")

// findAll reads every page by $skip. An empty page ends the scan even when
// the total disagrees, and the skip advances by what actually came back, so
// a backend that miscounts or clamps pages cannot spin or skip rows. With
// truncate, reaching maxPages returns what was read.
func findAll[T any](ctx context.Context, c *Client, path string, q Query, maxPages int, truncate bool) ([]T, error) {
	if maxPages <= 0 {
		maxPages = 200
	}
	size := c.PageSize
	if size <= 0 {
		size = 100
	}
	var rows []T
	skip := 0
	for range maxPages {
		pq := q.Set("$limit", strconv.Itoa(size)).Set("$skip", strconv.Itoa(skip))
		p, err := findPage[T](ctx, c, path, pq)
		if err != nil {
			return nil, err
		}
		rows = append(rows, p.Data...)
		if len(p.Data) == 0 || len(rows) >= p.Total {
			return rows, nil
		}
		skip += len(p.Data)
	}
	if truncate {
		return rows, nil
	}

	return nil, &RequestError{Message: fmt.Sprintf("Refusing to read more than %d pages from %s", maxPages, path)}
}
