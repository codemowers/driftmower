package scanner

import (
	"bytes"
	"encoding/json"
	"fmt"
)

const PartialScanReason = "java_db_unavailable"

type ScanProperty struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// AnnotateArtifact adds provenance without decoding or copying the component graph.
// Trivy does not emit BOM-level properties; reject already annotated input.
func AnnotateArtifact(body []byte, dbVersion, reason string) ([]byte, error) {
	var header struct {
		Format     string         `json:"bomFormat"`
		Properties []ScanProperty `json:"properties"`
	}
	if err := json.Unmarshal(body, &header); err != nil {
		return nil, err
	}
	if header.Format != "CycloneDX" || len(header.Properties) != 0 {
		return nil, fmt.Errorf("expected unannotated Trivy CycloneDX artifact")
	}
	if reason != "" && reason != PartialScanReason {
		return nil, fmt.Errorf("unknown partial scan reason")
	}
	coverage := "complete"
	if reason != "" {
		coverage = "partial"
	}
	properties := []ScanProperty{{"driftmower:scan:coverage", coverage}, {"driftmower:scan:db-version", dbVersion}}
	if reason != "" {
		properties = append(properties, ScanProperty{"driftmower:scan:partial-reason", reason})
	}
	prefix, err := json.Marshal(properties)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(body)+len(prefix)+20)
	out = append(out, `{"properties":`...)
	out = append(out, prefix...)
	out = append(out, ',')
	out = append(out, bytes.TrimSpace(body)[1:]...)
	return out, nil
}

func ScanCoverage(properties []ScanProperty) (coverage, reason, dbVersion string) {
	coverage = "unknown"
	for _, p := range properties {
		switch p.Name {
		case "driftmower:scan:coverage":
			coverage = p.Value
		case "driftmower:scan:partial-reason":
			reason = p.Value
		case "driftmower:scan:db-version":
			dbVersion = p.Value
		}
	}
	return
}
