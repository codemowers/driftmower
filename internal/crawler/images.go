package crawler

import (
	"fmt"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// SourceImage is observed source/image metadata, including unused images and
// images without a version. No filesystem layers or scan payloads are retained.
type SourceImage struct {
	Name       string   `json:"name"`
	Digest     string   `json:"digest,omitempty"`
	Image      string   `json:"image,omitempty"`
	Version    string   `json:"version,omitempty"`
	References []string `json:"references"`
	Unused     bool     `json:"unused"`
}
type SourceImages struct {
	Images     []SourceImage `json:"images"`
	Total      int           `json:"total"`
	NextOffset *int          `json:"nextOffset,omitempty"`
}

func (c *Crawler) SourceImages(url string, offset, limit int) (*SourceImages, error) {
	if url == "" || offset < 0 || limit < 1 || limit > 100 {
		return nil, fmt.Errorf("source URL and limit 1 to 100 are required; offset must be nonnegative")
	}
	raw, err := c.images.GetIndexer().ByIndex(sourceIndex, url)
	if err != nil {
		return nil, err
	}
	rows := make([]SourceImage, 0, len(raw))
	for _, item := range raw {
		image := item.(*unstructured.Unstructured)
		row := SourceImage{Name: image.GetName(), References: []string{}}
		if strings.HasPrefix(row.Name, "sha256-") {
			row.Digest = strings.Replace(row.Name, "sha256-", "sha256:", 1)
		}
		row.Image, _, _ = unstructured.NestedString(image.Object, "status", "image")
		row.Version, _, _ = unstructured.NestedString(image.Object, "status", "version")
		row.Unused, _, _ = unstructured.NestedBool(image.Object, "status", "unused")
		for _, field := range []string{"repoTags", "repoDigests"} {
			refs, _, _ := unstructured.NestedStringSlice(image.Object, field)
			row.References = append(row.References, refs...)
		}
		slices.Sort(row.References)
		row.References = slices.Compact(row.References)
		if row.Image == "" && len(row.References) > 0 {
			row.Image = row.References[0]
		}
		rows = append(rows, row)
	}
	slices.SortFunc(rows, func(a, b SourceImage) int { return strings.Compare(a.Name, b.Name) })
	start := min(offset, len(rows))
	end := min(start+limit, len(rows))
	out := &SourceImages{Images: rows[start:end], Total: len(rows)}
	if end < len(rows) {
		out.NextOffset = &end
	}
	return out, nil
}
