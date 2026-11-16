package crawler

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"testing"
)

func TestSourceImagePagesIncludeUnversionedAndUnusedImages(t *testing.T) {
	const url = "https://github.com/example/app"
	c := reportsCrawler(t, url, "1.0.0")
	for _, name := range []string{"unused", "unversioned", "unrelated"} {
		source := url
		if name == "unrelated" {
			source = "https://github.com/another/app"
		}
		obj := &unstructured.Unstructured{Object: map[string]any{"status": map[string]any{"source": source, "unused": name == "unused"}, "repoTags": []any{"example.com/app:tag"}}}
		obj.SetName(name)
		if err := c.images.GetIndexer().Add(obj); err != nil {
			t.Fatal(err)
		}
	}
	first, err := c.SourceImages(url, 0, 1)
	if err != nil || first.Total != 3 || first.NextOffset == nil {
		t.Fatalf("first page: %+v %v", first, err)
	}
	second, err := c.SourceImages(url, *first.NextOffset, 100)
	if err != nil || len(second.Images) != 2 || second.NextOffset != nil {
		t.Fatalf("second page: %+v %v", second, err)
	}
	foundUnused, foundUnversioned := false, false
	for _, image := range second.Images {
		foundUnused = foundUnused || image.Unused
		foundUnversioned = foundUnversioned || image.Version == ""
		if image.Name == "unrelated" {
			t.Fatal("another source leaked into this page")
		}
	}
	if !foundUnused || !foundUnversioned {
		t.Fatal("observed images were filtered like deployed versions")
	}
	if _, err := c.SourceImages(url, 0, 101); err == nil {
		t.Fatal("unbounded source image page accepted")
	}
}
