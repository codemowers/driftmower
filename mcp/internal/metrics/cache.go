package metrics

import (
	"github.com/codemowers/driftmower/mcp/internal/ttlcache"
	"github.com/prometheus/client_golang/prometheus"
)

// ObserveCaches registers fixed application cache names, never user keys.
func (m *Metrics) ObserveCaches(read func() map[string]ttlcache.Stats) {
	m.Registry.MustRegister(&cacheCollector{read: read})
}

type cacheCollector struct {
	read func() map[string]ttlcache.Stats
}

var cacheDescs = map[string]*prometheus.Desc{
	"entries":  prometheus.NewDesc("driftmower_cache_entries", "Retained cache entries, including expired entries awaiting eviction.", []string{"cache"}, nil),
	"expired":  prometheus.NewDesc("driftmower_cache_expired_entries", "Expired or invalidated values still retained in memory.", []string{"cache"}, nil),
	"capacity": prometheus.NewDesc("driftmower_cache_capacity_entries", "Maximum retained entries.", []string{"cache"}, nil),
	"keys":     prometheus.NewDesc("driftmower_cache_key_bytes", "Bytes in retained cache keys only; excludes cached values and map overhead.", []string{"cache"}, nil),
	"loading":  prometheus.NewDesc("driftmower_cache_loads_in_flight", "Shared cache loads currently in flight.", []string{"cache"}, nil),
}

func (c *cacheCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range cacheDescs {
		ch <- d
	}
}
func (c *cacheCollector) Collect(ch chan<- prometheus.Metric) {
	for name, s := range c.read() {
		for kind, value := range map[string]int{"entries": s.Entries, "expired": s.Expired, "capacity": s.Capacity, "keys": s.KeyBytes, "loading": s.Loading} {
			ch <- prometheus.MustNewConstMetric(cacheDescs[kind], prometheus.GaugeValue, float64(value), name)
		}
	}
}

func (m *Metrics) ObserveWorkloadObjects(read func() map[string]int) {
	m.Registry.MustRegister(&workloadCollector{read: read})
}

type workloadCollector struct{ read func() map[string]int }

var workloadDesc = prometheus.NewDesc("driftmower_workload_cache_objects", "Reduced objects retained by workload informers, by Kubernetes resource.", []string{"resource"}, nil)

func (c *workloadCollector) Describe(ch chan<- *prometheus.Desc) { ch <- workloadDesc }
func (c *workloadCollector) Collect(ch chan<- prometheus.Metric) {
	for resource, count := range c.read() {
		ch <- prometheus.MustNewConstMetric(workloadDesc, prometheus.GaugeValue, float64(count), resource)
	}
}
