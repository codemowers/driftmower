package mcpserver

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

type staticReports struct {
	reports []crawler.SourceReport
	err     error
}

func (s staticReports) Reports(context.Context) ([]crawler.SourceReport, error) {
	return s.reports, s.err
}

// denyImages allows everything but listing ContainerImages.
type denyImages struct{}

func (denyImages) MayPerform(_ context.Context, _ authz.Identity, a authz.Attributes) authz.Judgement {
	if a == listContainerImages {
		return authz.Judgement{Verdict: authz.No}
	}

	return authz.Judgement{Verdict: authz.Yes}
}

// One source with two deployed versions: 1.0.0 runs in team-a/api, and in
// another sandbox from that sandbox's own registry, and an advisory affects
// it; 0.9.0 is held by a node but run by no visible workload.
var crawled = []crawler.SourceReport{{
	URL:        "https://github.com/example/api",
	CheckedAt:  time.Date(2026, 11, 3, 6, 0, 0, 0, time.UTC),
	Latest:     &crawler.Release{Tag: "v1.2.0"},
	Releases:   []crawler.Release{{Tag: "v1.2.0", Notes: "Fixes and improvements", URL: "https://github.com/example/api/releases/tag/v1.2.0"}},
	Advisories: []crawler.Advisory{{ID: "GHSA-test", Summary: "Remote crash", URL: "https://github.com/advisories/GHSA-test"}},
	Deployed: []crawler.DeployedVersion{{
		Version: "1.0.0", Behind: 2, LatestOnLine: "1.0.3",
		Images:   []string{"registry.example.com/api:1", "registry.sb-other.example.com/api:1"},
		Findings: []crawler.Finding{{Advisory: "GHSA-test", Severity: "high", Confidence: crawler.Affected, FixedIn: "1.0.3"}},
	}, {
		Version: "0.9.0", Behind: 3, Images: []string{"registry.example.com/api:0.9"},
	}},
}}

func findingsSession(t *testing.T, source FindingsSource, judge authz.Judge) *mcp.ClientSession {
	t.Helper()
	yes := true
	labels := map[string]string{"app": "api"}
	k := fake.NewClientset(
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api", UID: "d1"}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api-1", UID: "r1",
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: "api", UID: "d1", Controller: &yes}}}},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api-1-x", UID: "p1", Labels: labels,
				OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "api-1", UID: types.UID("r1"), Controller: &yes}}},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "registry.example.com/api:1"}, {Image: "registry.example.com/sidecar:2"}}},
		},
	)
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	meta := metadatafake.NewSimpleMetadataClient(scheme)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	logger := slog.New(slog.DiscardHandler)
	c := &workloads.Cache{Kubernetes: k, Metadata: meta, Dynamic: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		Discovery: k.Discovery(), Judge: judge, Logger: logger,
		Scope: &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a"}, nil }, Judge: judge}}
	c.Start(ctx)
	id := "bravo.example.com"

	return connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger,
		Mapping:   auth.Mapping{UsernameClaim: "sub"},
		Workloads: &Workloads{Cache: c, Metadata: meta, Judge: judge},
		Findings:  source,
	}))
}

func TestSourceFindings(t *testing.T) {
	s := findingsSession(t, staticReports{reports: crawled}, allowAll{})

	text, out := call(t, s, "get_source_findings", nil)
	if text != "1 sources; 1 with a deployed version an advisory affects." {
		t.Errorf("summary = %q", text)
	}
	if _, exists := out["sources"].([]any)[0].(map[string]any)["releases"]; exists {
		t.Fatal("unfiltered overview must not include every release body")
	}
	_, detail := call(t, s, "get_source_findings", map[string]any{"url": "https://github.com/example/api"})
	releases := detail["sources"].([]any)[0].(map[string]any)["releases"].([]any)
	if len(releases) != 1 || releases[0].(map[string]any)["notes"] != "Fixes and improvements" {
		t.Fatalf("release notes missing: %v", releases)
	}
	deployed := out["sources"].([]any)[0].(map[string]any)["deployed"].([]any)
	if len(deployed) != 2 {
		t.Fatalf("a caller who may list ContainerImages sees every version: %v", deployed)
	}
	current := deployed[0].(map[string]any)
	if images := current["images"].([]any); len(images) != 2 {
		t.Errorf("a caller who may list ContainerImages sees every image: %v", images)
	}
	finding := current["findings"].([]any)[0].(map[string]any)
	workload := current["workloads"].([]any)[0].(map[string]any)
	if finding["advisory"] != "GHSA-test" || finding["summary"] != "Remote crash" || finding["fixedIn"] != "1.0.3" ||
		workload["namespace"] != "team-a" || workload["kind"] != "Deployment" || workload["name"] != "api" {
		t.Errorf("1.0.0 = %v", current)
	}

	_, out = call(t, s, "get_source_findings", map[string]any{"affectedOnly": true})
	if deployed := out["sources"].([]any)[0].(map[string]any)["deployed"].([]any); len(deployed) != 1 {
		t.Errorf("affectedOnly kept %v", deployed)
	}
	_, out = call(t, s, "get_source_findings", map[string]any{"url": "https://github.com/example/other"})
	if sources := out["sources"].([]any); len(sources) != 0 {
		t.Errorf("url filter kept %v", sources)
	}
}

func TestSourceFindingsWithoutContainerImages(t *testing.T) {
	s := findingsSession(t, staticReports{reports: crawled}, denyImages{})

	_, out := call(t, s, "get_source_findings", nil)
	deployed := out["sources"].([]any)[0].(map[string]any)["deployed"].([]any)
	if len(deployed) != 1 || deployed[0].(map[string]any)["version"] != "1.0.0" {
		t.Fatalf("only versions the caller's workloads run are shown: %v", deployed)
	}
	if images := deployed[0].(map[string]any)["images"].([]any); len(images) != 1 || images[0] != "registry.example.com/api:1" {
		t.Errorf("another namespace's image references leak: %v", images)
	}
	if warnings := out["warnings"].([]any); !strings.Contains(warnings[0].(string), "ContainerImages") {
		t.Errorf("warnings = %v", warnings)
	}
}

func TestWorkloadFindings(t *testing.T) {
	s := findingsSession(t, staticReports{reports: crawled}, allowAll{})

	text, out := call(t, s, "get_workload_findings", map[string]any{"namespace": "team-a", "name": "api"})
	if text != "1 workloads; 1 run an image with advisory findings." {
		t.Errorf("summary = %q", text)
	}
	api := out["workloads"].([]any)[0].(map[string]any)
	image := api["images"].([]any)[0].(map[string]any)
	if image["source"] != "https://github.com/example/api" || image["version"] != "1.0.0" || image["latest"] != "v1.2.0" {
		t.Errorf("image = %v", image)
	}
	if untracked := api["untracked"].([]any); len(untracked) != 1 || untracked[0] != "registry.example.com/sidecar:2" {
		t.Errorf("untracked = %v", untracked)
	}

	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_workload_findings", Arguments: map[string]any{"name": "api"}})
	if err != nil || !res.IsError {
		t.Errorf("name without namespace: %v %v", res, err)
	}
}

func TestFindingsWithoutCrawler(t *testing.T) {
	s := findingsSession(t, staticReports{err: errors.New("connection refused")}, allowAll{})

	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_workload_findings", Arguments: map[string]any{"namespace": "team-a"}})
	if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "crawler could not be reached") {
		t.Errorf("unreachable crawler: %v %v", res, err)
	}
}

func TestFindingsToolsNeedACrawler(t *testing.T) {
	s := findingsSession(t, nil, allowAll{})

	tools, err := s.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if strings.HasSuffix(tool.Name, "_findings") {
			t.Errorf("%s registered without a crawler", tool.Name)
		}
	}
}

// Right after a crawler restart nothing is crawled: the crawler reports every
// version as unknown with "not crawled yet", and the tools must not pass that
// off as current and clean.
func TestFindingsBeforeTheFirstCrawl(t *testing.T) {
	notCrawled := []crawler.SourceReport{{
		URL:    "https://github.com/example/api",
		Errors: []string{"not crawled yet"},
		Deployed: []crawler.DeployedVersion{{
			Version: "1.0.0", Behind: -1, Images: []string{"registry.example.com/api:1"},
		}},
	}}
	s := findingsSession(t, staticReports{reports: notCrawled}, allowAll{})

	text, out := call(t, s, "get_workload_findings", map[string]any{"namespace": "team-a"})
	if !strings.Contains(text, "1 images were not fully checked") {
		t.Errorf("summary = %q", text)
	}
	image := out["workloads"].([]any)[0].(map[string]any)["images"].([]any)[0].(map[string]any)
	if image["behind"] != float64(-1) || image["checkedAt"] != nil || image["errors"].([]any)[0] != "not crawled yet" {
		t.Errorf("image = %v", image)
	}

	text, _ = call(t, s, "get_source_findings", nil)
	if !strings.Contains(text, "1 not fully crawled yet or with errors") {
		t.Errorf("summary = %q", text)
	}
}
