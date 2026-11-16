package crawler

import "github.com/prometheus/client_golang/prometheus"

var crawlerFootprints = map[string]*prometheus.Desc{
	"entries": prometheus.NewDesc("driftmower_crawler_retained_entries", "Retained crawler objects by structure; advisory counts include references held by each OSV query, not unique advisories.", []string{"structure"}, nil),
	"bytes":   prometheus.NewDesc("driftmower_crawler_retained_payload_bytes", "Logical retained payload bytes; excludes Go object/map overhead and allocator capacity. Categories may share backing storage and must not be added to infer heap usage.", []string{"structure"}, nil),
}

type crawlerFootprintCollector struct{ crawler *Crawler }

func (*crawlerFootprintCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range crawlerFootprints {
		ch <- d
	}
}

func (v *crawlerFootprintCollector) Collect(ch chan<- prometheus.Metric) {
	c := v.crawler
	entries := map[string]int{"sources": 0, "releases": 0, "advisories": 0, "osv_queries": 0, "osv_advisories": 0, "versions": 0, "revisions": 0, "http_cache": 0}
	payload := map[string]int{"http_cache_bodies": 0, "http_cache_keys": 0, "changelogs": 0, "release_notes": 0}
	c.mu.RLock()
	entries["sources"] = len(c.state)
	for _, s := range c.state {
		if s == nil {
			continue
		}
		entries["releases"] += len(s.releases)
		entries["advisories"] += len(s.advisories)
		entries["osv_queries"] += len(s.osv)
		entries["versions"] += len(s.versions)
		entries["revisions"] += len(s.revisions)
		for _, a := range s.osv {
			entries["osv_advisories"] += len(a)
		}
		if s.changelog != nil {
			payload["changelogs"] += len(s.changelog.Text)
		}
		for _, r := range s.releases {
			payload["release_notes"] += len(r.Notes)
		}
	}
	c.mu.RUnlock()
	fetchers := []*fetcher{c.fetch}
	for _, f := range c.enterprise {
		fetchers = append(fetchers, f)
	}
	for _, f := range fetchers {
		if f == nil {
			continue
		}
		f.mu.Lock()
		entries["http_cache"] = len(f.cache)
		for key, cached := range f.cache {
			payload["http_cache_keys"] += len(key)
			payload["http_cache_bodies"] += len(cached.body)
		}
		f.mu.Unlock()
	}
	if c.sources != nil {
		entries["source_informer"] = len(c.sources.GetStore().ListKeys())
	}
	if c.images != nil {
		entries["image_informer"] = len(c.images.GetStore().ListKeys())
	}
	for structure, count := range entries {
		ch <- prometheus.MustNewConstMetric(crawlerFootprints["entries"], prometheus.GaugeValue, float64(count), structure)
	}
	for structure, size := range payload {
		ch <- prometheus.MustNewConstMetric(crawlerFootprints["bytes"], prometheus.GaugeValue, float64(size), structure)
	}
}
