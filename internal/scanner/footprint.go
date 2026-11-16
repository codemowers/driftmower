package scanner

import "github.com/prometheus/client_golang/prometheus"

var scannerFootprints = map[string]*prometheus.Desc{
	"entries": prometheus.NewDesc("driftmower_scanner_retained_entries", "Retained scanner objects; summaries contain aggregate counts, never full SBOMs. Queue count excludes currently processing and delayed items.", []string{"structure"}, nil),
	"keys":    prometheus.NewDesc("driftmower_scanner_summary_key_bytes", "Retained summary key bytes only; excludes maps, counters and Go object overhead.", nil, nil),
}

type scannerFootprintCollector struct{ controller *Controller }

func (*scannerFootprintCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range scannerFootprints {
		ch <- d
	}
}
func (s *scannerFootprintCollector) Collect(ch chan<- prometheus.Metric) {
	c := s.controller
	counts := map[string]int{"summaries": 0, "summary_classes": 0}
	keyBytes := 0
	c.summaries.Range(func(key, value any) bool {
		counts["summaries"]++
		counts["summary_classes"] += len(value.(vulnerabilitySummary).Counts)
		keyBytes += len(key.(string))
		return true
	})
	if c.informer != nil {
		counts["image_informer"] = len(c.informer.GetStore().ListKeys())
	}
	if c.podStore != nil {
		counts["pod_store"] = len(c.podStore.ListKeys())
	}
	if c.queue != nil {
		counts["queue_ready"] = c.queue.Len()
	}
	for structure, count := range counts {
		ch <- prometheus.MustNewConstMetric(scannerFootprints["entries"], prometheus.GaugeValue, float64(count), structure)
	}
	ch <- prometheus.MustNewConstMetric(scannerFootprints["keys"], prometheus.GaugeValue, float64(keyBytes))
}
