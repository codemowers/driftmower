package crawler

import (
	"log/slog"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

// reportsCrawler is a crawler whose informer stores hold one source deployed
// at the given versions, without running the informers.
func reportsCrawler(t *testing.T, url string, versions ...string) *Crawler {
	t.Helper()
	c := New(Config{Interval: time.Hour}, dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()), slog.New(slog.DiscardHandler))
	source := &unstructured.Unstructured{Object: map[string]any{"spec": map[string]any{"url": url}}}
	source.SetName("source")
	if err := c.sources.GetStore().Add(source); err != nil {
		t.Fatal(err)
	}
	for _, version := range versions {
		image := &unstructured.Unstructured{Object: map[string]any{
			"status": map[string]any{"source": url, "version": version, "image": "example.com/app:" + version},
		}}
		image.SetName("image-" + version)
		if err := c.images.GetIndexer().Add(image); err != nil {
			t.Fatal(err)
		}
	}

	return c
}

func deployedBehind(t *testing.T, c *Crawler) map[string]int {
	t.Helper()
	reports := c.Reports()
	if len(reports) != 1 {
		t.Fatalf("reports = %+v", reports)
	}
	out := map[string]int{}
	for _, d := range reports[0].Deployed {
		out[d.Version] = d.Behind
	}

	return out
}

func TestReportsDoNotClaimCurrentWithoutReleases(t *testing.T) {
	const url = "https://github.com/example/app"

	c := reportsCrawler(t, url, "1.0.0")
	if got := deployedBehind(t, c)["1.0.0"]; got != -1 {
		t.Errorf("not crawled yet: behind = %d, want -1", got)
	}
	if errs := c.Reports()[0].Errors; len(errs) != 1 || errs[0] != "not crawled yet" {
		t.Errorf("errors = %v", errs)
	}

	// A crawl whose releases request failed leaves no releases.
	c.state[url] = &sourceState{checkedAt: time.Now(), errors: []string{"releases: HTTP 403"}}
	if got := deployedBehind(t, c)["1.0.0"]; got != -1 {
		t.Errorf("failed releases crawl: behind = %d, want -1", got)
	}
}

func TestReportsCountReleasesOnTheVersionsPrefix(t *testing.T) {
	const url = "https://github.com/example/mono"

	c := reportsCrawler(t, url, "1.0.0", "1.2.0", "app-1.0.0")
	c.state[url] = &sourceState{checkedAt: time.Now(), releases: []Release{
		{Tag: "v1.0.1"}, {Tag: "v1.1.0"}, {Tag: "v1.2.0"}, {Tag: "v2.0.0-rc.1", Prerelease: true},
	}}
	got := deployedBehind(t, c)
	if got["1.0.0"] != 3 || got["1.2.0"] != 0 {
		t.Errorf("behind = %v, want 1.0.0: 3 and 1.2.0: 0", got)
	}
	// No release carries the app- prefix, so app-1.0.0 cannot be compared.
	if got["app-1.0.0"] != -1 {
		t.Errorf("app-1.0.0 behind = %d, want -1", got["app-1.0.0"])
	}
}

func TestReportsRetainStableReleaseNotes(t *testing.T) {
	const url = "https://github.com/example/app"
	c := reportsCrawler(t, url, "v1.0.0")
	c.state[url] = &sourceState{checkedAt: time.Now(), releases: []Release{
		{Tag: "v1.1.0", Notes: "Fixes and improvements", URL: url + "/releases/tag/v1.1.0"},
		{Tag: "v1.2.0-rc1", Prerelease: true, Notes: "Preview"},
	}}
	report := c.Reports()[0]
	if len(report.Releases) != 1 || report.Releases[0].Notes != "Fixes and improvements" || report.Latest.Notes != report.Releases[0].Notes {
		t.Fatalf("release notes lost or prerelease included: %+v", report)
	}
}
