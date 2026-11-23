package crawler

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
	Images []SourceImage `json:"images"`
}
