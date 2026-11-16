package scanner

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type findingClass struct{ Severity, Fix string }
type vulnerabilitySummary struct {
	AcceptedAt                                float64
	Counts                                    map[findingClass]int
	TrivyVersion, DBVersion, Coverage, Reason string
}

// summarizeArtifact parses each persisted artifact once, with one parser at a
// time to bound peak memory. It retains no components, CVE IDs or package data.
func (c *Controller) summarizeArtifact(key string) error {
	c.artifacts.Lock()
	defer c.artifacts.Unlock()
	if _, ok := c.summaries.Load(key); ok {
		return nil
	}
	f, err := os.Open(filepath.Join(c.Config.CacheDir, key+".json"))
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > MaxSBOMBytes {
		return fmt.Errorf("persisted SBOM exceeds size limit")
	}
	summary, err := summarizeVulnerabilities(io.LimitReader(f, MaxSBOMBytes+1))
	if err != nil {
		return err
	}
	summary.AcceptedAt = float64(info.ModTime().Unix())
	c.summaries.Store(key, summary)
	return nil
}

func summarizeVulnerabilities(r io.Reader) (vulnerabilitySummary, error) {
	var bom struct {
		Format     string         `json:"bomFormat"`
		Properties []ScanProperty `json:"properties"`
		Metadata   struct {
			Tools struct {
				Components []struct{ Name, Version string } `json:"components"`
			} `json:"tools"`
		} `json:"metadata"`
		Vulnerabilities []struct {
			ID      string `json:"id"`
			Ratings []struct {
				Severity string `json:"severity"`
			} `json:"ratings"`
			Recommendation string `json:"recommendation"`
			Analysis       struct {
				State string `json:"state"`
			} `json:"analysis"`
			Affects []struct {
				Ref      string                             `json:"ref"`
				Versions []struct{ Version, Status string } `json:"versions"`
			} `json:"affects"`
		} `json:"vulnerabilities"`
	}
	d := json.NewDecoder(r)
	if err := d.Decode(&bom); err != nil {
		return vulnerabilitySummary{}, err
	}
	if bom.Format != "CycloneDX" {
		return vulnerabilitySummary{}, fmt.Errorf("invalid CycloneDX artifact")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return vulnerabilitySummary{}, fmt.Errorf("trailing SBOM data")
	}
	ranks := map[string]int{"UNKNOWN": 0, "NONE": 1, "LOW": 2, "MEDIUM": 3, "HIGH": 4, "CRITICAL": 5}
	// Merge duplicate ID/component observations conservatively, retaining the
	// highest severity and only an explicitly reported remediation.
	seen := map[string]findingClass{}
	for _, v := range bom.Vulnerabilities {
		switch v.Analysis.State {
		case "not_affected", "resolved", "resolved_with_pedigree", "false_positive":
			continue
		}
		if v.ID == "" {
			continue
		}
		severity := "UNKNOWN"
		for _, rating := range v.Ratings {
			if value := strings.ToUpper(rating.Severity); ranks[value] > ranks[severity] {
				severity = value
			}
		}
		_, version, upgrade := strings.Cut(v.Recommendation, " to version ")
		fix := strings.HasPrefix(v.Recommendation, "Upgrade ") && upgrade && strings.TrimSpace(version) != ""
		if len(v.Affects) == 0 {
			key := v.ID + "\x00"
			class := seen[key]
			if ranks[severity] > ranks[class.Severity] || class.Severity == "" {
				class.Severity = severity
			}
			if fix {
				class.Fix = "available"
			} else if class.Fix == "" {
				class.Fix = "unknown"
			}
			seen[key] = class
		}
		for _, affected := range v.Affects {
			available := fix
			for _, version := range affected.Versions {
				if version.Status == "unaffected" && version.Version != "" {
					available = true
				}
			}
			key := v.ID + "\x00" + affected.Ref
			class := seen[key]
			if ranks[severity] > ranks[class.Severity] || class.Severity == "" {
				class.Severity = severity
			}
			if available {
				class.Fix = "available"
			} else if class.Fix == "" {
				class.Fix = "unknown"
			}
			seen[key] = class
		}
	}
	out := vulnerabilitySummary{Counts: map[findingClass]int{}}
	out.Coverage, out.Reason, out.DBVersion = ScanCoverage(bom.Properties)
	for _, tool := range bom.Metadata.Tools.Components {
		if strings.EqualFold(tool.Name, "trivy") {
			out.TrivyVersion = tool.Version
		}
	}
	for _, class := range seen {
		out.Counts[class]++
	}
	return out, nil
}

var securityDescs = map[string]*prometheus.Desc{
	"ready":     prometheus.NewDesc("driftmower_scanner_inventory_ready", "Whether scanner inventory is synchronized; zero means coverage is unknown.", nil, nil),
	"available": prometheus.NewDesc("driftmower_image_scan_available", "Whether the current scanner/database configuration has a readable summarized artifact for this manifest.", []string{"image", "digest", "trivy_version", "db_version", "coverage", "reason"}, nil),
	"accepted":  prometheus.NewDesc("driftmower_image_scan_accepted_timestamp_seconds", "Artifact file modification Unix timestamp (acceptance time), not vulnerability database age.", []string{"image", "digest", "trivy_version", "db_version", "coverage", "reason"}, nil),
	"findings":  prometheus.NewDesc("driftmower_image_vulnerabilities", "Unique vulnerability ID/component findings, by highest reported severity and explicit fix availability; no CVE IDs or packages in labels. Zero-count classes are omitted.", []string{"image", "digest", "severity", "fix_status", "trivy_version", "db_version", "coverage", "reason"}, nil),
	"exhausted": prometheus.NewDesc("driftmower_image_scan_attempts_exhausted", "Whether the current manifest scan has exhausted its retry budget without a usable artifact.", []string{"image", "digest"}, nil),
	"state":     prometheus.NewDesc("driftmower_image_scan_state", "One current lifecycle per immutable manifest digest, deduplicated across image aliases. No Pod or workload labels. Failed means the retry budget is exhausted; done requires a usable current artifact.", []string{"digest", "state", "trivy_version", "db_version", "coverage", "reason"}, nil),
	"manifest":  prometheus.NewDesc("driftmower_image_manifest_info", "Image/index digest identity to immutable platform digest relationship; separate from per-digest scan state.", []string{"image", "digest"}, nil),
}

type securityCollector struct{ controller *Controller }

func (*securityCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range securityDescs {
		ch <- d
	}
}
func (s *securityCollector) Collect(ch chan<- prometheus.Metric) {
	c := s.controller
	ready := 0.
	if c.ready.Load() {
		ready = 1
	}
	ch <- prometheus.MustNewConstMetric(securityDescs["ready"], prometheus.GaugeValue, ready)
	if ready == 0 || c.informer == nil {
		return
	}
	states := map[string]string{}
	versions := map[string]vulnerabilitySummary{}
	mappings := map[[2]string]bool{}
	priority := map[string]int{"failed": 0, "unavailable": 1, "pending": 2, "running": 3, "partial": 4, "done": 5}
	for _, obj := range c.informer.GetStore().List() {
		image := obj.(*unstructured.Unstructured)
		if image.GetDeletionTimestamp() != nil {
			continue
		}
		manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
		aliases := map[string]bool{image.GetName(): true}
		addAlias := func(digest string) {
			if len(digest) == 71 && strings.HasPrefix(digest, "sha256:") && strings.Trim(digest[7:], "0123456789abcdef") == "" {
				aliases[strings.Replace(digest, "sha256:", "sha256-", 1)] = true
			}
		}
		index, _, _ := unstructured.NestedString(image.Object, "index", "digest")
		addAlias(index)
		refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
		for _, ref := range refs {
			if _, digest, ok := strings.Cut(ref, "@"); ok {
				addAlias(digest)
			}
		}
		seen := map[string]bool{}
		for _, raw := range manifests {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			digest, _ := m["digest"].(string)
			arch, _ := m["architecture"].(string)
			if digest == "" || arch == "" || seen[digest] {
				continue
			}
			seen[digest] = true
			for alias := range aliases {
				pair := [2]string{alias, digest}
				if !mappings[pair] {
					ch <- prometheus.MustNewConstMetric(securityDescs["manifest"], prometheus.GaugeValue, 1, alias, digest)
					mappings[pair] = true
				}
			}
			key := Key(digest, c.Config.Image, c.Config.TrivyImage, c.Config.DatabaseImage)
			available := 0.
			value := vulnerabilitySummary{Coverage: "unknown"}
			if summary, ok := c.summaries.Load(key); ok {
				if exists, err := c.artifactExists(key); err == nil && exists {
					available = 1
					value = summary.(vulnerabilitySummary)
					ch <- prometheus.MustNewConstMetric(securityDescs["accepted"], prometheus.GaugeValue, value.AcceptedAt, image.GetName(), digest, value.TrivyVersion, value.DBVersion, value.Coverage, value.Reason)
					for class, count := range value.Counts {
						ch <- prometheus.MustNewConstMetric(securityDescs["findings"], prometheus.GaugeValue, float64(count), image.GetName(), digest, class.Severity, class.Fix, value.TrivyVersion, value.DBVersion, value.Coverage, value.Reason)
					}
				}
			}
			ch <- prometheus.MustNewConstMetric(securityDescs["available"], prometheus.GaugeValue, available, image.GetName(), digest, value.TrivyVersion, value.DBVersion, value.Coverage, value.Reason)
			state := c.scanLifecycle(image, digest, key, available == 1)
			if available == 1 && value.Coverage == "partial" {
				state = "partial"
			}
			if previous, ok := states[digest]; !ok || priority[state] > priority[previous] {
				states[digest] = state
				versions[digest] = value
			}
			if state == "failed" {
				ch <- prometheus.MustNewConstMetric(securityDescs["exhausted"], prometheus.GaugeValue, 1, image.GetName(), digest)
			}
		}
	}
	for digest, state := range states {
		ch <- prometheus.MustNewConstMetric(securityDescs["state"], prometheus.GaugeValue, 1, digest, state, versions[digest].TrivyVersion, versions[digest].DBVersion, versions[digest].Coverage, versions[digest].Reason)
	}
}
