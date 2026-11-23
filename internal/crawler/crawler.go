// Package crawler fetches releases and security advisories for every source
// repository images on the cluster were built from, and matches them against
// the versions deployed. Everything it learns stays in memory.
package crawler

import (
	"context"
	"errors"
	"github.com/codemowers/driftmower/internal/imagesource"
	"log/slog"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
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
	Interval         time.Duration
	GitHubToken      string
	GitHubEnterprise map[string]string
	GiteaHosts       []string
	OSVURL           string
}

type Crawler struct {
	cfg        Config
	fetch      *fetcher
	enterprise map[string]*fetcher
	osvURL     string
	log        *slog.Logger
	sources    cache.SharedIndexInformer
	images     cache.SharedIndexInformer
	wake       chan struct{}
	// Resources the API server does not serve: their CRDs, which nodestatd
	// installs, are missing, so there is nothing to wait for.
	sourcesMissing, imagesMissing atomic.Bool

	mu           sync.RWMutex
	state        map[string]*sourceState
	activeSource string

	// provenance indexes image layer chains to recognise source claims
	// inherited from a base image; rebuilt lazily after image changes.
	provenanceMu    sync.Mutex
	provenance      *imagesource.Index
	provenanceStale atomic.Bool
}

// sourceState is what the crawler last learned about a source.
type sourceState struct {
	checkedAt    time.Time
	due          time.Time
	errors       []string
	unauthorized bool
	releases     []Release
	advisories   []Advisory
	// The repository's changelog file as fetched; nil when it has none.
	changelog *Changelog
	license   *RepositoryLicense
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
	c.enterprise = map[string]*fetcher{}
	for host, token := range cfg.GitHubEnterprise {
		f := newEnterpriseFetcher(host, token)
		f.metrics = c.fetch.metrics
		c.enterprise[host] = f
	}
	c.sources = dynamicinformer.NewFilteredDynamicInformer(client, sourceRepositories, metav1.NamespaceAll, 0, cache.Indexers{}, nil).Informer()
	c.images = dynamicinformer.NewFilteredDynamicInformer(client, containerImages, metav1.NamespaceAll, 0, cache.Indexers{
		sourceIndex: func(obj any) ([]string, error) {
			// Claims inherited from a base image's metadata are not this
			// image's source; deployed() also checks extended base images.
			source := imagesource.Of(obj.(*unstructured.Unstructured).Object, nil).Source
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
	stale := func() { c.provenanceStale.Store(true) }
	c.images.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: func(any) { stale() }, UpdateFunc: func(any, any) { stale() }, DeleteFunc: func(any) { stale() }})
	missing := func(flag *atomic.Bool, resource string) cache.WatchErrorHandlerWithContext {
		return func(ctx context.Context, r *cache.Reflector, err error) {
			if apierrors.IsNotFound(err) {
				if !flag.Swap(true) {
					log.Warn("resource not served; install nodestatd's CRDs", "resource", resource)
				}
				return
			}
			flag.Store(false)
			cache.DefaultWatchErrorHandler(ctx, r, err)
		}
	}
	_ = c.sources.SetWatchErrorHandlerWithContext(missing(&c.sourcesMissing, sourceRepositories.Resource))
	_ = c.images.SetWatchErrorHandlerWithContext(missing(&c.imagesMissing, containerImages.Resource))
	return c
}

// Missing names the resources the API server does not serve.
func (c *Crawler) Missing() []string {
	var out []string
	if c.imagesMissing.Load() && !c.images.HasSynced() {
		out = append(out, containerImages.Resource+"."+containerImages.Group)
	}
	if c.sourcesMissing.Load() && !c.sources.HasSynced() {
		out = append(out, sourceRepositories.Resource+"."+sourceRepositories.Group)
	}
	return out
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

// keepImage keeps an image's status, references, revision metadata and what
// imagesource needs to tell its own source claim from an inherited one.
func keepImage(obj any) (any, error) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj, nil
	}
	reduced, _ := keep(nil)(obj)
	out := reduced.(*unstructured.Unstructured)
	for field, value := range imagesource.Reduce(u.Object) {
		if field != "metadata" && field != "apiVersion" && field != "kind" {
			out.Object[field] = value
		}
	}
	return out, nil
}

// provenanceIndex returns the layer-chain index of every known image.
func (c *Crawler) provenanceIndex() *imagesource.Index {
	c.provenanceMu.Lock()
	defer c.provenanceMu.Unlock()
	if c.provenance == nil || c.provenanceStale.Swap(false) {
		items := c.images.GetStore().List()
		objs := make([]map[string]any, 0, len(items))
		for _, item := range items {
			objs = append(objs, item.(*unstructured.Unstructured).Object)
		}
		c.provenance = imagesource.NewIndex(objs)
	}
	return c.provenance
}

func (c *Crawler) nudge() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// Synced reports whether both informers completed their initial list, or
// found their resource not served, which no waiting will change.
func (c *Crawler) Synced() bool {
	return (c.sources.HasSynced() || c.sourcesMissing.Load()) && (c.images.HasSynced() || c.imagesMissing.Load())
}

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
	index := c.provenanceIndex()
	for _, item := range items {
		obj := item.(*unstructured.Unstructured).Object
		claim := imagesource.Of(obj, index)
		if claim.Source != url {
			continue
		}
		if unused, _, _ := unstructured.NestedBool(obj, "status", "unused"); unused {
			continue
		}
		version := claim.Version
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
	c.mu.Lock()
	c.activeSource = url
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.activeSource = ""; c.mu.Unlock() }()
	state := &sourceState{checkedAt: time.Now(), versions: map[string]bool{}, revisions: map[string]bool{}, osv: map[string][]Advisory{}}
	jitter := time.Duration(rand.Int64N(int64(c.cfg.Interval)/10 + 1))
	state.due = state.checkedAt.Add(c.cfg.Interval + jitter)
	loc, supported := c.locate(url)
	fail := func(what string, err error) {
		if ctx.Err() == nil {
			detail := err.Error()
			if errors.Is(err, errUnauthorized) {
				state.unauthorized = true
			}
			// The release reader has already tried tags when releases were
			// missing. Unlike a missing license/changelog, a missing tag
			// collection means this repository itself cannot be read. GitHub
			// conceals private repositories behind 404 responses.
			if what == "releases" && loc.forge == GitHub && errors.Is(err, errNotFound) {
				state.unauthorized = true
				detail = "unauthorized: repository not found or inaccessible to the crawler credentials (HTTP 404)"
			}
			state.errors = append(state.errors, what+": "+detail)
		}
	}
	versions, revisions := c.deployed(url)
	if supported {
		license, err := c.repositoryLicense(ctx, loc)
		if err != nil {
			fail("license", err)
		}
		state.license = license
		releases, err := c.releases(ctx, loc)
		if err != nil {
			fail("releases", err)
		}
		state.releases = releases
		changelog, err := c.changelog(ctx, loc)
		if err != nil {
			fail("changelog", err)
		}
		state.changelog = changelog
		if loc.forge == GitHub {
			advisories, err := c.githubAdvisories(ctx, loc)
			if err != nil {
				fail("advisories", err)
			}
			state.advisories = advisories
		}
		for version := range versions {
			state.versions[version] = true
			if v, ok := ParseVersion(version); ok && v.Prefix == "" && c.enterprise[loc.host] == nil {
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
		if c.enterprise[loc.host] != nil {
			continue
		}
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
	if len(state.errors) > 0 {
		c.log.Warn("crawled with errors", "source", url, "releases", len(state.releases), "advisories", len(state.advisories), "errors", len(state.errors), "errorDetails", state.errors, "githubRemaining", remaining)
	} else {
		c.log.Info("crawled", "source", url, "releases", len(state.releases), "advisories", len(state.advisories), "githubRemaining", remaining)
	}
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
	License      *RepositoryLicense `json:"license,omitempty"`
	Scraping     bool               `json:"scraping,omitempty"`
	URL          string             `json:"url"`
	CheckedAt    time.Time          `json:"checkedAt,omitzero"`
	NextCrawl    time.Time          `json:"nextCrawl,omitzero"`
	Errors       []string           `json:"errors,omitempty"`
	Unauthorized bool               `json:"unauthorized,omitempty"`
	Releases     []Release          `json:"releases,omitempty"`
	Latest       *Release           `json:"latest,omitempty"`
	Deployed     []DeployedVersion  `json:"deployed"`
	Advisories   []Advisory         `json:"advisories,omitempty"`
	// The changelog file found in the repository; its text is served by
	// /v1/changes, parsed.
	Changelog *Changelog `json:"changelog,omitempty"`
}

type DeployedVersion struct {
	Status  map[string]any `json:"versionStatus,omitempty"`
	Version string         `json:"version"`
	Images  []string       `json:"images"`
	// References are every tag and digest reference nodes hold the images
	// under, for matching Pod image fields.
	References []string `json:"references,omitempty"`
	// Behind counts newer stable releases; -1 when the version cannot be
	// compared: it does not parse, or no stable release on its own tag prefix
	// is known, as before a source's first successful crawl.
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
		report := SourceReport{URL: url, Scraping: c.activeSource == url, Deployed: []DeployedVersion{}}
		state := c.state[url]
		versions, _ := c.deployed(url)
		if state == nil {
			report.Errors = []string{"not crawled yet"}
		} else {
			report.CheckedAt, report.NextCrawl, report.Errors, report.Changelog = state.checkedAt, state.due, state.errors, state.changelog
			report.License = state.license
			report.Unauthorized = state.unauthorized
		}
		releases, advisories := stableReleases(state), map[string]Advisory{}
		for _, release := range releases {
			report.Releases = append(report.Releases, release.Release)
		}
		for _, version := range sortedKeys(versions) {
			deployed := DeployedVersion{Version: version, Images: versions[version].images, References: versions[version].references, Behind: -1}
			v, ok := ParseVersion(version)
			if ok {
				deployed.Behind = behind(releases, v)
				for _, r := range releases {
					if r.version.Prefix != v.Prefix || r.version.Compare(v) <= 0 {
						continue
					}
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

// behind counts stable releases newer than v on its own tag prefix. Without
// any release on that prefix there is nothing to compare against, which is
// unknown, not current.
func behind(releases []parsedRelease, v Version) int {
	known, newer := false, 0
	for _, r := range releases {
		if r.version.Prefix != v.Prefix {
			continue
		}
		known = true
		if r.version.Compare(v) > 0 {
			newer++
		}
	}
	if !known {
		return -1
	}

	return newer
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
