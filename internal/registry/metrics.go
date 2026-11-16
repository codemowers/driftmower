package registry

import "github.com/prometheus/client_golang/prometheus"

var registryFootprint = prometheus.NewDesc("driftmower_registry_retained_entries", "Retained registry metadata and layer index entries. Images and tags may reference the same content; index references do not duplicate image objects. Raw manifests/configuration are stored on disk.", []string{"structure"}, nil)

func (*Store) Describe(ch chan<- *prometheus.Desc) { ch <- registryFootprint }
func (s *Store) Collect(ch chan<- prometheus.Metric) {
	counts := map[string]int{"repositories": 0, "images": 0, "tags": 0, "layers": 0, "compressed_index_nodes": 0, "compressed_index_references": 0, "diffid_index_nodes": 0, "diffid_index_references": 0}
	s.mu.RLock()
	counts["repositories"] = len(s.repositories)
	for _, repo := range s.repositories {
		counts["images"] += len(repo.Images)
		for _, image := range repo.Images {
			counts["tags"] += len(image.Tags)
			counts["layers"] += len(image.Layers)
		}
	}
	var walk func(*layerNode, string)
	walk = func(n *layerNode, prefix string) {
		if n == nil {
			return
		}
		counts[prefix+"_nodes"]++
		counts[prefix+"_references"] += len(n.images)
		for _, child := range n.children {
			walk(child, prefix)
		}
	}
	walk(s.compressed, "compressed_index")
	walk(s.uncompressed, "diffid_index")
	s.mu.RUnlock()
	for structure, count := range counts {
		ch <- prometheus.MustNewConstMetric(registryFootprint, prometheus.GaugeValue, float64(count), structure)
	}
}
