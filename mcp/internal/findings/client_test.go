package findings

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestClientReadsCompactReportsWithoutRetainingThem(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer projected" {
			t.Error("missing projected token")
		}
		if calls < 3 && r.URL.Query().Get("summary") != "advisories" {
			t.Error("bulk read requested full release notes")
		}
		if calls == 3 && r.URL.Query().Get("url") != "https://example.com/app" {
			t.Error("detail did not select one source")
		}
		fmt.Fprintf(w, `{"sources":[{"url":"https://example.com/app","deployed":[{"version":"%d"}]}]}`, calls)
	}))
	defer s.Close()
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("projected"), 0600); err != nil {
		t.Fatal(err)
	}
	c := &Client{URL: s.URL, TokenFile: file, HTTP: s.Client()}
	for _, want := range []string{"1", "2"} {
		r, err := c.Reports(context.Background())
		if err != nil || r[0].Deployed[0].Version != want {
			t.Fatalf("read %v %v", r, err)
		}
	}
	if _, err := c.SourceDetails(context.Background(), "https://example.com/app"); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("calls %d", calls)
	}
}
