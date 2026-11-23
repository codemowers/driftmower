package crawler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCrawlerMCPOwnEvidenceOnly(t *testing.T) {
	url := "https://github.com/example/app"
	c := &Crawler{state: map[string]*sourceState{url: {releases: []Release{{Tag: "v1.0.0"}}, advisories: []Advisory{{ID: "GHSA-example"}}, osv: map[string][]Advisory{"private-deployed-version": {{ID: "OSV-example"}}}}}}
	all := c.CrawledSources("")
	if len(all) != 1 || len(all[0].Releases) != 0 || len(all[0].Advisories) != 0 || all[0].ReleaseCount != 1 || all[0].AdvisoryCount != 2 {
		t.Fatalf("unbounded/incomplete summary: %+v", all)
	}
	handler := c.MCP("test", func(r *http.Request) error {
		if r.Header.Get("Authorization") != "Bearer accepted" {
			return errors.New("denied")
		}
		return nil
	})
	for _, allowed := range []bool{false, true} {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_crawled_sources","arguments":{"url":"` + url + `"}}}`
		r := httptest.NewRequest(http.MethodPost, "http://crawler/mcp", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		if allowed {
			r.Header.Set("Authorization", "Bearer accepted")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if !allowed {
			if w.Code != http.StatusForbidden {
				t.Fatalf("unauthenticated status %d", w.Code)
			}
			continue
		}
		var response struct {
			Result struct {
				Structured outputForTest `json:"structuredContent"`
			} `json:"result"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Error != nil || len(response.Result.Structured.Sources) != 1 {
			t.Fatalf("MCP response: %d %s, err=%v", w.Code, w.Body, err)
		}
		for _, secret := range []string{"private-deployed-version", `"deployed"`, `"images"`, `"references"`} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatalf("inventory leaked: %s", w.Body)
			}
		}
		if !strings.Contains(w.Body.String(), "GHSA-example") || !strings.Contains(w.Body.String(), "OSV-example") {
			t.Fatalf("missing fetched evidence: %s", w.Body)
		}
	}
}

type outputForTest struct {
	Sources []CrawledSource `json:"sources"`
}
