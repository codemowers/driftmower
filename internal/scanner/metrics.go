package scanner

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// MaxSBOMBytes is shared by the uploader, artifact store and MCP reader.
const MaxSBOMBytes = 32 << 20

// OversizedSBOMMediaType reports a generated artifact's size without uploading
// its contents. It uses the same Pod-bound authentication as artifact uploads.
const OversizedSBOMMediaType = "application/vnd.driftmower.sbom-size+json"

type SBOMSizeReport struct {
	SizeBytes int64 `json:"sizeBytes"`
}

type scanMetrics struct {
	registry  *prometheus.Registry
	size      prometheus.Histogram
	oversized *prometheus.GaugeVec
}

func newScanMetrics() *scanMetrics {
	m := &scanMetrics{
		registry: prometheus.NewRegistry(),
		size: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "driftmower_sbom_size_bytes",
			Help:    "Generated SBOM sizes reported by authenticated scan Pods, including rejected oversized artifacts. Oversized streams without size reports contribute a lower bound. Upload retries may repeat observations.",
			Buckets: []float64{64 << 10, 256 << 10, 1 << 20, 4 << 20, 8 << 20, 16 << 20, MaxSBOMBytes},
		}),
		oversized: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "driftmower_sbom_size_limit_exceeded_bytes",
			Help: "Last oversized SBOM size by ContainerImage and platform digest; cleared by a valid upload. Process-local state resets on operator restart.",
		}, []string{"image", "digest"}),
	}
	m.registry.MustRegister(m.size, m.oversized, collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}
