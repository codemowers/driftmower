package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

type sourceTransport func(*http.Request) (*http.Response, error)

func (f sourceTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestReleaseTagFallback(t *testing.T) {
	for _, forge := range []struct {
		name, repository, releases, tags, tagURL string
	}{
		{GitHub, "https://github.com/org/app", githubAPI + "/repos/org/app/releases?per_page=100", githubAPI + "/repos/org/app/tags?per_page=100", "https://github.com/org/app/tree/"},
		{Gitea, "https://codeberg.org/org/app", "https://codeberg.org/api/v1/repos/org/app/releases?limit=50", "https://codeberg.org/api/v1/repos/org/app/tags?limit=50", "https://codeberg.org/org/app/src/tag/"},
		{GitLab, "https://gitlab.com/org/group/app", "https://gitlab.com/api/v4/projects/org%2Fgroup%2Fapp/releases?per_page=100", "https://gitlab.com/api/v4/projects/org%2Fgroup%2Fapp/repository/tags?per_page=100", "https://gitlab.com/org/group/app/-/tags/"},
	} {
		for _, scenario := range []struct {
			name, body          string
			status, tagStatus   int
			fallback, wantError bool
		}{
			{"empty releases", `[]`, 200, 200, true, false},
			{"no release collection", `[]`, 404, 200, true, false},
			{"repository unavailable", `[]`, 404, 404, true, true},
			{"published release", `[{"tag_name":"v1.1.0","body":"Release notes","description":"Release notes"}]`, 200, 200, false, false},
			{"release request failed", `[]`, 403, 200, false, true},
			{"tag request failed", `[]`, 200, 403, true, true},
			{"draft only", `[{"tag_name":"v2.0.0","draft":true}]`, 200, 200, true, false},
		} {
			if forge.name == GitLab && scenario.name == "draft only" {
				continue // GitLab's release API does not use the draft field.
			}
			t.Run(forge.name+"/"+scenario.name, func(t *testing.T) {
				var requests []string
				client := &http.Client{Transport: sourceTransport(func(r *http.Request) (*http.Response, error) {
					requests = append(requests, r.URL.String())
					body, status := scenario.body, scenario.status
					switch r.URL.String() {
					case forge.releases:
					case forge.tags:
						body, status = `[{"name":"v1.1.0"},{"name":"v2.0.0-rc.1"},{"name":"build/test"}]`, scenario.tagStatus
					default:
						return nil, fmt.Errorf("unexpected request: %s", r.URL)
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
				c := reportsCrawler(t, forge.repository, "v1.0.0")
				c.fetch = newFetcher(client, "")
				loc, ok := locate(forge.repository, nil)
				if !ok {
					t.Fatal("unsupported test source")
				}
				releases, err := c.releases(context.Background(), loc)
				if (err != nil) != scenario.wantError {
					t.Fatalf("releases error = %v", err)
				}
				wantRequests := []string{forge.releases}
				if scenario.fallback {
					wantRequests = append(wantRequests, forge.tags)
				}
				if !reflect.DeepEqual(requests, wantRequests) {
					t.Fatalf("requests = %v, want %v", requests, wantRequests)
				}
				if scenario.wantError {
					return
				}
				if scenario.fallback {
					if len(releases) != 3 || releases[0].URL != forge.tagURL+"v1.1.0" || releases[2].URL != forge.tagURL+"build%2Ftest" || !releases[1].Prerelease {
						t.Fatalf("tag fallback = %+v", releases)
					}
					if releases[0].Notes != "" || !releases[0].Published.IsZero() {
						t.Fatalf("tag has invented release metadata: %+v", releases[0])
					}
				} else if len(releases) != 1 || releases[0].Notes != "Release notes" {
					t.Fatalf("published release = %+v", releases)
				}
				c.state[forge.repository] = &sourceState{checkedAt: time.Now(), releases: releases}
				report := c.Reports()[0]
				if len(report.Releases) != 1 || report.Latest == nil || report.Latest.Tag != "v1.1.0" || report.Deployed[0].Behind != 1 {
					t.Fatalf("stable version comparison = %+v", report)
				}
			})
		}
	}
}

func TestLargeGitHubReleasesUseSmallerPages(t *testing.T) {
	for _, splitLaterPage := range []bool{false, true} {
		t.Run(fmt.Sprintf("later-page-too-large=%v", splitLaterPage), func(t *testing.T) {
			padding := strings.Repeat("x", 90_000)
			var requests []string
			client := &http.Client{Transport: sourceTransport(func(r *http.Request) (*http.Response, error) {
				requests = append(requests, r.URL.String())
				if r.URL.Path != "/repos/emqx/emqx/releases" {
					t.Fatalf("must not fall back to tags: %s", r.URL)
				}
				size, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
				page, _ := strconv.Atoi(r.URL.Query().Get("page"))
				if page == 0 {
					page = 1
				}
				var items []map[string]any
				for i := (page - 1) * size; i < min(page*size, 100); i++ {
					tag := fmt.Sprintf("5.8.%d", 100-i)
					if i == 0 {
						tag = "6.3.2"
					}
					asset := padding
					if splitLaterPage && size == 50 && page == 2 {
						asset += padding
					}
					items = append(items, map[string]any{"tag_name": tag, "body": "Release notes for " + tag, "assets": []map[string]string{{"name": asset}}})
				}
				body, err := json.Marshal(items)
				if err != nil {
					t.Fatal(err)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})}
			c := reportsCrawler(t, "https://github.com/emqx/emqx", "5.8.6")
			c.fetch = newFetcher(client, "")
			loc, _ := locate("https://github.com/emqx/emqx", nil)
			releases, err := c.releases(context.Background(), loc)
			if err != nil {
				t.Fatal(err)
			}
			if len(releases) != 100 || releases[0].Tag != "6.3.2" || releases[99].Tag != "5.8.1" {
				t.Fatalf("lost releases while changing page size: count=%d", len(releases))
			}
			seen := map[string]bool{}
			for _, release := range releases {
				if seen[release.Tag] || release.Notes != "Release notes for "+release.Tag {
					t.Fatalf("duplicated release or lost notes: %+v", release)
				}
				seen[release.Tag] = true
			}
			wantRequests := 3 // The rejected 100-release response and two 50-release pages.
			if splitLaterPage {
				wantRequests = 7 // Restart from page one with 25 releases per page.
			}
			if len(requests) != wantRequests {
				t.Fatalf("requests: %v", requests)
			}
		})
	}
}

func TestOversizedSingleGitHubReleaseRemainsError(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: sourceTransport(func(r *http.Request) (*http.Response, error) {
		requests++
		if requests > 7 || r.URL.Path != "/repos/emqx/emqx/releases" {
			t.Fatalf("unbounded retries or tag fallback: %s", r.URL)
		}
		body := `[{"tag_name":"6.3.2","body":"` + strings.Repeat("x", maxBody) + `"}]`
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	c := reportsCrawler(t, "https://github.com/emqx/emqx", "5.8.6")
	c.fetch = newFetcher(client, "")
	loc, _ := locate("https://github.com/emqx/emqx", nil)
	releases, err := c.releases(context.Background(), loc)
	if !errors.Is(err, errResponseTooLarge) || len(releases) != 0 || requests != 7 {
		t.Fatalf("expected bounded size error without partial releases: requests=%d err=%v", requests, err)
	}
}
