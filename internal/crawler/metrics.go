package crawler

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var crawlerReady = prometheus.NewDesc("driftmower_crawler_inventory_ready", "Whether source and image inventories are synchronized and their CRDs are available.", nil, nil)
var crawlerSources = prometheus.NewDesc("driftmower_crawler_sources", "Registered source repositories by latest scrape state; failed includes partially incomplete sources. No source URLs or errors are metric labels.", []string{"state"}, nil)

func (c *Crawler) Metrics() http.Handler {
	r := prometheus.NewRegistry()
	r.MustRegister(&crawlerCollector{crawler: c}, &crawlerFootprintCollector{crawler: c}, c.fetch.metrics.duration, c.fetch.metrics.requests, c.fetch.metrics.downloads,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return promhttp.HandlerFor(r, promhttp.HandlerOpts{})
}

type crawlerCollector struct{ crawler *Crawler }

func (*crawlerCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- crawlerReady
	ch <- crawlerSources
}
func (v *crawlerCollector) Collect(ch chan<- prometheus.Metric) {
	c := v.crawler
	ready := 0.
	if c.Synced() && len(c.Missing()) == 0 {
		ready = 1
	}
	ch <- prometheus.MustNewConstMetric(crawlerReady, prometheus.GaugeValue, ready)
	if ready == 0 {
		return
	}
	urls := c.urls()
	counts := map[string]int{"pending": 0, "scraping": 0, "failed": 0, "ready": 0}
	c.mu.RLock()
	for _, url := range urls {
		state := c.state[url]
		switch {
		case c.activeSource == url:
			counts["scraping"]++
		case state == nil || state.checkedAt.IsZero():
			counts["pending"]++
		case len(state.errors) > 0:
			counts["failed"]++
		default:
			counts["ready"]++
		}
	}
	c.mu.RUnlock()
	for state, count := range counts {
		ch <- prometheus.MustNewConstMetric(crawlerSources, prometheus.GaugeValue, float64(count), state)
	}
}
