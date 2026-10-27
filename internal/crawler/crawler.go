// Package crawler fetches releases and security advisories for every source
// repository images on the cluster were built from, and matches them against
// the versions deployed. Everything it learns stays in memory.
package crawler

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

var (
	sourceRepositories = schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "sourcerepositories"}
	containerImages    = schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "containerimages"}
	revisionPattern    = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

const sourceIndex = "source"

type Config struct {
	// Interval between crawls of a source; each is jittered by up to a
	// tenth.
	Interval    time.Duration
	GitHubToken string
	GiteaHosts  []string
	OSVURL      string
}

type Crawler struct {
	cfg     Config
	fetch   *fetcher
	osvURL  string
	log     *slog.Logger
	sources cache.SharedIndexInformer
	images  cache.SharedIndexInformer
	wake    chan struct{}

	mu    sync.RWMutex
	state map[string]*sourceState
}

// sourceState is what the crawler last learned about a source.
type sourceState struct {
	checkedAt  time.Time
	due        time.Time
	errors     []string
	releases   []Release
	advisories []Advisory
	// versions and revisions crawled, so new ones trigger a crawl.
	versions  map[string]bool
	revisions map[string]bool
	// osv holds OSV advisories by the deployed version or revision they were
	// queried for.
	osv map[string][]Advisory
}

func New(cfg Config, client dynamic.Interface, log *slog.Logger) *Crawler {
	if cfg.OSVURL == "" {
		cfg.OSVURL = "https://api.osv.dev"
	}
	c := &Crawler{cfg: cfg, fetch: newFetcher(PublicHTTPClient(), cfg.GitHubToken), osvURL: cfg.OSVURL, log: log,
		wake: make(chan struct{}, 1), state: map[string]*sourceState{}}
	c.sources = dynamicinformer.NewFilteredDynamicInformer(client, sourceRepositories, metav1.NamespaceAll, 0, cache.Indexers{}, nil).Informer()
	c.images = dynamicinformer.NewFilteredDynamicInformer(client, containerImages, metav1.NamespaceAll, 0, cache.Indexers{
		sourceIndex: func(obj any) ([]string, error) {
			source, _, _ := unstructured.NestedString(obj.(*unstructured.Unstructured).Object, "status", "source")
			if source == "" {
				return nil, nil
			}
			return []string{source}, nil
		},
	}, nil).Informer()
	c.sources.SetTransform(keep([]string{"spec"}))
	c.images.SetTransform(keepImage)
	nudge := cache.ResourceEventHandlerFuncs{AddFunc: func(any) { c.nudge() }, UpdateFunc: func(any, any) { c.nudge() }}
	c.sources.AddEventHandler(nudge)
	c.images.AddEventHandler(nudge)
	return c
}

// keep reduces informer objects to their identity and the named top-level
// fields.
func keep(fields []string) cache.TransformFunc {
	return func(obj any) (any, error) {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			return obj, nil
		}
		out := &unstructured.Unstructured{Object: map[string]any{"apiVersion": u.GetAPIVersion(), "kind": u.GetKind()}}
		out.SetName(u.GetName())
		out.SetUID(u.GetUID())
		out.SetResourceVersion(u.GetResourceVersion())
		for _, field := range fields {
			if value, ok := u.Object[field]; ok {
				out.Object[field] = value
			}
		}
		return out, nil
	}
}

// keepImage keeps an image's status, references and revision metadata.
func keepImage(obj any) (any, error) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj, nil
	}
	reduced, _ := keep([]string{"status", "repoTags", "repoDigests"})(obj)
	out := reduced.(*unstructured.Unstructured)
	for _, field := range []string{"annotations", "labels"} {
		if revision, _, _ := unstructured.NestedString(u.Object, field, "org.opencontainers.image.revision"); revision != "" {
			unstructured.SetNestedField(out.Object, revision, field, "org.opencontainers.image.revision")
		}
	}
	return out, nil
}

func (c *Crawler) nudge() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// Synced reports whether both informers completed their initial list.
func (c *Crawler) Synced() bool { return c.sources.HasSynced() && c.images.HasSynced() }

// Run watches sources and images and crawls each source when it is due:
// first seen, its interval elapsed, or a newly deployed version or revision.
// Crawls run one at a time, which also paces requests to GitHub.
func (c *Crawler) Run(ctx context.Context) {
	go c.sources.RunWithContext(ctx)
	go c.images.RunWithContext(ctx)
	cache.WaitForCacheSync(ctx.Done(), c.sources.HasSynced, c.images.HasSynced)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		for {
			url, ok := c.next()
			if !ok || ctx.Err() != nil {
				break
			}
			c.crawl(ctx, url)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-c.wake:
		}
	}
}

// next picks the most overdue source, dropping state of sources that are
// gone.
func (c *Crawler) next() (string, bool) {
	urls := c.urls()
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for url := range c.state {
		if !slices.Contains(urls, url) {
			delete(c.state, url)
		}
	}
	var best string
	var bestDue time.Time
	for _, url := range urls {
		due := time.Time{}
		if state := c.state[url]; state != nil {
			due = state.due
			versions, revisions := c.deployed(url)
			for version := range versions {
				if !state.versions[version] {
					due = time.Time{}
				}
			}
			for _, revision := range revisions {
				if !state.revisions[revision] {
					due = time.Time{}
				}
			}
		}
		if due.After(now) {
			continue
		}
		if best == "" || due.Before(bestDue) {
			best, bestDue = url, due
		}
	}
	return best, best != ""
}

func (c *Crawler) urls() []string {
	var urls []string
	for _, obj := range c.sources.GetStore().List() {
		if url, _, _ := unstructured.NestedString(obj.(*unstructured.Unstructured).Object, "spec", "url"); url != "" {
			urls = append(urls, url)
		}
	}
	slices.Sort(urls)
	return slices.Compact(urls)
}

// deployment is one version of a source in use: its images' display
// references, every tag and digest reference nodes hold them under, and the
// commits they were built from.
type deployment struct {
	images, references, revisions []string
}

// deployed returns the versions of in-use images of a source and every
// revision among them.
func (c *Crawler) deployed(url string) (map[string]*deployment, []string) {
	versions := map[string]*deployment{}
	var revisions []string
	items, _ := c.images.GetIndexer().ByIndex(sourceIndex, url)
	for _, item := range items {
		obj := item.(*unstructured.Unstructured).Object
		if unused, _, _ := unstructured.NestedBool(obj, "status", "unused"); unused {
			continue
		}
		version, _, _ := unstructured.NestedString(obj, "status", "version")
		if version == "" {
			continue
		}
		d := versions[version]
		if d == nil {
			d = &deployment{}
			versions[version] = d
		}
		image, _, _ := unstructured.NestedString(obj, "status", "image")
		d.images = append(d.images, image)
		for _, field := range []string{"repoTags", "repoDigests"} {
			refs, _, _ := unstructured.NestedStringSlice(obj, field)
			d.references = append(d.references, refs...)
		}
		for _, field := range []string{"annotations", "labels"} {
			if revision, _, _ := unstructured.NestedString(obj, field, "org.opencontainers.image.revision"); revisionPattern.MatchString(revision) {
				d.revisions = append(d.revisions, revision)
				revisions = append(revisions, revision)
				break
			}
		}
	}
	for _, d := range versions {
		slices.Sort(d.images)
		d.images = slices.Compact(d.images)
		slices.Sort(d.references)
		d.references = slices.Compact(d.references)
		slices.Sort(d.revisions)
		d.revisions = slices.Compact(d.revisions)
	}
	slices.Sort(revisions)
	return versions, slices.Compact(revisions)
}

func (c *Crawler) crawl(ctx context.Context, url string) {
	state := &sourceState{checkedAt: time.Now(), versions: map[string]bool{}, revisions: map[string]bool{}, osv: map[string][]Advisory{}}
	jitter := time.Duration(rand.Int64N(int64(c.cfg.Interval)/10 + 1))
	state.due = state.checkedAt.Add(c.cfg.Interval + jitter)
	fail := func(what string, err error) {
		if ctx.Err() == nil {
			state.errors = append(state.errors, what+": "+err.Error())
		}
	}
	versions, revisions := c.deployed(url)
	loc, supported := locate(url, c.cfg.GiteaHosts)
	if supported {
		releases, err := c.releases(ctx, loc)
		if err != nil {
			fail("releases", err)
		}
		state.releases = releases
		if loc.forge == GitHub {
			advisories, err := c.githubAdvisories(ctx, loc)
			if err != nil {
				fail("advisories", err)
			}
			state.advisories = advisories
		}
		for version := range versions {
			state.versions[version] = true
			if v, ok := ParseVersion(version); ok && v.Prefix == "" {
				query := map[string]any{"package": map[string]any{"name": goModule(loc, v), "ecosystem": "Go"}, "version": strings.Join(intStrings(v.Core), ".")}
				advisories, err := c.osvQuery(ctx, query)
				if err != nil {
					fail("osv "+version, err)
				}
				state.osv[version] = advisories
			}
		}
	} else {
		state.errors = append(state.errors, "releases and repository advisories: unsupported forge")
		for version := range versions {
			state.versions[version] = true
		}
	}
	for _, revision := range revisions {
		state.revisions[revision] = true
		advisories, err := c.osvQuery(ctx, map[string]any{"commit": revision})
		if err != nil {
			fail("osv "+revision, err)
		}
		state.osv[revision] = advisories
	}
	if ctx.Err() != nil {
		return
	}
	c.mu.Lock()
	c.state[url] = state
	c.mu.Unlock()
	remaining, _ := c.fetch.RateLimit()
	c.log.Info("crawled", "source", url, "releases", len(state.releases), "advisories", len(state.advisories), "errors", len(state.errors), "githubRemaining", remaining)
}

func intStrings(values []int) []string {
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = strconv.Itoa(value)
	}
	return out
}

// SourceReport is what the crawler knows about one source, matched against
// the versions currently deployed.
type SourceReport struct {
	URL       string    `json:"url"`
	CheckedAt time.Time `json:"checkedAt,omitzero"`
	NextCrawl time.Time `json:"nextCrawl,omitzero"`
	Errors    []string  `json:"errors,omitempty"`
	// Latest is the newest stable release.
	Latest     *Release          `json:"latest,omitempty"`
	Deployed   []DeployedVersion `json:"deployed"`
	Advisories []Advisory        `json:"advisories,omitempty"`
}

type DeployedVersion struct {
	Version string   `json:"version"`
	Images  []string `json:"images"`
	// References are every tag and digest reference nodes hold the images
	// under, for matching Pod image fields.
	References []string `json:"references,omitempty"`
	// Behind counts newer stable releases; -1 when the version cannot be
	// compared.
	Behind int `json:"behind"`
	// LatestOnLine is the newest stable release on the version's own
	// major.minor line.
	LatestOnLine string    `json:"latestOnLine,omitempty"`
	Findings     []Finding `json:"findings,omitempty"`
}

type Finding struct {
	Advisory   string     `json:"advisory"`
	Severity   string     `json:"severity,omitempty"`
	Confidence Confidence `json:"confidence"`
	FixedIn    string     `json:"fixedIn,omitempty"`
}

// Reports matches crawled data against current deployments. Advisories are
// listed only when they affect a deployed version.
func (c *Crawler) Reports() []SourceReport {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var out []SourceReport
	for _, url := range c.urls() {
		report := SourceReport{URL: url, Deployed: []DeployedVersion{}}
		state := c.state[url]
		versions, _ := c.deployed(url)
		if state == nil {
			report.Errors = []string{"not crawled yet"}
		} else {
			report.CheckedAt, report.NextCrawl, report.Errors = state.checkedAt, state.due, state.errors
		}
		releases, advisories := stableReleases(state), map[string]Advisory{}
		for _, version := range sortedKeys(versions) {
			deployed := DeployedVersion{Version: version, Images: versions[version].images, References: versions[version].references, Behind: -1}
			v, ok := ParseVersion(version)
			if ok {
				deployed.Behind = 0
				for _, r := range releases {
					if r.version.Prefix != v.Prefix || r.version.Compare(v) <= 0 {
						continue
					}
					deployed.Behind++
					if r.version.Line(v) && (deployed.LatestOnLine == "" || r.version.Compare(mustParse(deployed.LatestOnLine)) > 0) {
						deployed.LatestOnLine = r.Tag
					}
				}
				if state != nil {
					candidates := append(slices.Clone(state.advisories), state.osv[version]...)
					for _, revision := range versions[version].revisions {
						candidates = append(candidates, state.osv[revision]...)
					}
					deployed.Findings = match(candidates, v, advisories)
				}
			}
			report.Deployed = append(report.Deployed, deployed)
		}
		if len(releases) > 0 {
			latest := releases[0].Release
			report.Latest = &latest
		}
		for _, id := range sortedKeys(advisories) {
			report.Advisories = append(report.Advisories, advisories[id])
		}
		out = append(out, report)
	}
	return out
}

type parsedRelease struct {
	Release
	version Version
}

// stableReleases returns parseable non-prerelease releases, newest first.
func stableReleases(state *sourceState) []parsedRelease {
	if state == nil {
		return nil
	}
	var out []parsedRelease
	for _, r := range state.releases {
		if v, ok := ParseVersion(r.Tag); ok && !r.Prerelease {
			out = append(out, parsedRelease{r, v})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].version.Compare(out[j].version) > 0 })
	return out
}

// match returns the findings for v, one per advisory, merging an advisory
// known under several IDs and keeping the strongest confidence. Matched
// advisories are added to seen.
func match(candidates []Advisory, v Version, seen map[string]Advisory) []Finding {
	byID := map[string]*Finding{}
	alias := map[string]string{}
	for _, advisory := range candidates {
		id := advisory.ID
		for _, other := range append([]string{advisory.ID}, advisory.Aliases...) {
			if canonical, ok := alias[other]; ok {
				id = canonical
				break
			}
		}
		var best Confidence
		var patched []string
		if advisory.Origin == "osv" && len(advisory.Ranges) == 0 {
			// OSV matched the exact version or commit itself.
			best = Affected
		}
		for _, r := range advisory.Ranges {
			confidence, ok := MatchRange(r.Range, v)
			if !ok && advisory.Origin == "osv" {
				// OSV already matched this version; its ranges only
				// carry fix versions.
				confidence, ok = Affected, true
			}
			if !ok {
				continue
			}
			if best != Affected {
				best = confidence
			}
			patched = append(patched, r.Patched...)
		}
		if best == "" {
			continue
		}
		for _, other := range append([]string{advisory.ID}, advisory.Aliases...) {
			alias[other] = id
		}
		finding := byID[id]
		if finding == nil {
			finding = &Finding{Advisory: id, Severity: advisory.Severity}
			byID[id] = finding
			seen[id] = advisory
		}
		if finding.Confidence != Affected {
			finding.Confidence = best
		}
		if finding.Severity == "" {
			finding.Severity = advisory.Severity
		}
		if fixed := FixedIn(patched, v); fixed != "" && (finding.FixedIn == "" || mustParse(fixed).Compare(mustParse(finding.FixedIn)) < 0) {
			finding.FixedIn = fixed
		}
	}
	var out []Finding
	for _, id := range sortedKeys(byID) {
		out = append(out, *byID[id])
	}
	return out
}

func mustParse(raw string) Version {
	v, _ := ParseVersion(raw)
	return v
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
