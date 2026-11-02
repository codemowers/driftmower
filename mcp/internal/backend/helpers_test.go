package backend

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/codemowers/driftmower-mcp/internal/testutil/fakebackend"
)

type Row = fakebackend.Row

var ctx = context.Background()

func clientFor(b *fakebackend.Backend) *Client {
	return &Client{BaseURL: b.URL, Token: b.Token}
}

// fake serves only the given services' rows, with empty defaults for the rest.
func fake(t *testing.T, rows map[string][]Row) (*fakebackend.Backend, *Client) {
	t.Helper()
	all := map[string][]Row{"reports": {}, "image-usages": {}, "release-scores": {}}
	for k, v := range rows {
		all[k] = v
	}
	b := fakebackend.New(t, all)

	return b, clientFor(b)
}

func report(id, cluster, createdAt string, extra Row) Row {
	r := Row{"id": id, "clusterContext": cluster, "createdAt": createdAt, "sourceType": "cluster", "status": "ready",
		"namespaceScope": map[string]any{"mode": "all"}}
	for k, v := range extra {
		r[k] = v
	}

	return r
}

var selectedScope = map[string]any{"mode": "selected", "namespaces": []any{"apps"}}

func release(reportID, groupKey string, info any) Row {
	raw, _ := json.Marshal(info)

	return Row{"reportId": reportID, "groupKey": groupKey, "releaseInfo": string(raw)}
}

func str(s string) *string { return &s }
