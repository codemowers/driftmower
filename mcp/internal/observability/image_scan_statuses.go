package observability

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type ImageScanStatus struct {
	Status  string `json:"status"`
	Partial int    `json:"partial"`
	Done    int    `json:"done"`
	Pending int    `json:"pending"`
	Running int    `json:"running"`
	Failed  int    `json:"failed"`
	Total   int    `json:"total"`
	Reason  string `json:"reason,omitempty"`
}
type ImageScanStatuses struct {
	Images map[string]ImageScanStatus `json:"images"`
}

func (s *Service) ImageScanStatuses(ctx context.Context, id authz.Identity, digests []string) (*ImageScanStatuses, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("Prometheus is not configured")
	}
	if len(digests) == 0 || len(digests) > 100 {
		return nil, errors.New("provide 1 to 100 digests")
	}
	platforms, images := []string{}, []string{}
	for _, digest := range digests {
		if len(digest) != 71 || !strings.HasPrefix(digest, "sha256:") || strings.Trim(digest[7:], "0123456789abcdef") != "" {
			return nil, errors.New("invalid sha256 digest")
		}
		platforms = append(platforms, regexp.QuoteMeta(digest))
		images = append(images, regexp.QuoteMeta(strings.Replace(digest, "sha256:", "sha256-", 1)))
	}
	owner := []string{}
	if s.ScannerNamespace != "" {
		owner = append(owner, "driftmower_namespace="+promString(s.ScannerNamespace))
	}
	if s.ScannerInstance != "" {
		owner = append(owner, "driftmower_instance="+promString(s.ScannerInstance))
	}
	base := strings.Join(owner, ",")
	filter := func(extra string) string {
		if base != "" && extra != "" {
			return "{" + base + "," + extra + "}"
		}
		return "{" + base + extra + "}"
	}
	state := `driftmower:image_scan_state:max`
	query := `max by (image,digest,state) (` + state + filter("digest=~"+promString(strings.Join(platforms, "|"))) + ` or (` +
		`driftmower:image_manifest_info:max` + filter("image=~"+promString(strings.Join(images, "|"))) +
		` * on (digest,driftmower_namespace,driftmower_instance) group_left (state) ` + state + filter("") + `))`
	out := &ImageScanStatuses{Images: map[string]ImageScanStatus{}}
	err := func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Group: "codemowers.io", Resource: "containerimages", Verb: "list"}, "Kubernetes RBAC denied list ContainerImages"); err != nil {
			return err
		}
		rows, warnings, err := s.vector(ctx, backend, query, s.alignedNow().UTC().Format("2006-01-02T15:04:05Z"))
		if err != nil {
			return err
		}
		if len(warnings) > 0 {
			return fmt.Errorf("incomplete scan status metrics: %s", strings.Join(warnings, "; "))
		}
		for _, requested := range digests {
			exact := false
			for _, sample := range rows {
				exact = exact || sample.Labels["digest"] == requested
			}
			states := map[string]string{}
			for _, sample := range rows {
				digest, state := sample.Labels["digest"], sample.Labels["state"]
				if sample.Value != 1 || digest == "" {
					continue
				}
				if exact && digest != requested || !exact && sample.Labels["image"] != strings.Replace(requested, "sha256:", "sha256-", 1) {
					continue
				}
				if previous, ok := states[digest]; ok && previous != state {
					states[digest] = "unavailable"
				} else {
					states[digest] = state
				}
			}
			row := ImageScanStatus{Total: len(states)}
			unknown := false
			for _, state := range states {
				switch state {
				case "done":
					row.Done++
				case "partial":
					row.Partial++
				case "pending":
					row.Pending++
				case "running":
					row.Running++
				case "failed":
					row.Failed++
				default:
					unknown = true
				}
			}
			switch {
			case row.Total == 0:
				row.Status = "unavailable"
				row.Reason = "Scan-state metrics are absent or stale; check scanner scraping and rule selection"
			case unknown:
				row.Status = "unavailable"
				row.Reason = "Scan state is unknown or conflicting"
			case row.Done == row.Total:
				row.Status = "done"
			case row.Failed > 0:
				row.Status = "failed"
				row.Reason = "Current scan retry budget exhausted; inspect the image scan attempts"
			case row.Running > 0:
				row.Status = "running"
			case row.Partial > 0:
				row.Status = "partial"
				row.Reason = "Java archives were skipped because the Java DB was unavailable; OS and other language findings remain usable"
			case row.Done > 0:
				row.Status = "partial"
			default:
				row.Status = "pending"
			}
			out.Images[requested] = row
		}
		return nil
	}(s.Backend)
	if err != nil {
		return nil, fmt.Errorf("scan status: %w", err)
	}
	return out, nil
}
