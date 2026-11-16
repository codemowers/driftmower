// Package registry indexes public OCI image metadata for base-image matching.
// It never downloads or executes filesystem layers.
package registry

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var digestPattern = regexp.MustCompile(`^(sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$`)
var repositoryPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*(:[0-9]+)?/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$`)

func sha256Digest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func VerifyDigest(digest string, body []byte) error {
	if !digestPattern.MatchString(digest) {
		return fmt.Errorf("invalid OCI digest %q", digest)
	}
	var actual string
	if strings.HasPrefix(digest, "sha256:") {
		sum := sha256.Sum256(body)
		actual = "sha256:" + hex.EncodeToString(sum[:])
	} else {
		sum := sha512.Sum512(body)
		actual = "sha512:" + hex.EncodeToString(sum[:])
	}
	if actual != digest {
		return fmt.Errorf("OCI digest mismatch: wanted %s, got %s", digest, actual)
	}
	return nil
}

type Platform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Variant      string `json:"variant,omitempty"`
}

type Layer struct {
	Digest    string `json:"digest"`
	DiffID    string `json:"diffID,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	Size      int64  `json:"size"`
}

type Image struct {
	Repository   string            `json:"repository"`
	Digest       string            `json:"digest"`
	ConfigDigest string            `json:"configDigest"`
	Tags         []string          `json:"tags"`
	CurrentTags  []string          `json:"currentTags"`
	Platform     Platform          `json:"platform"`
	Layers       []Layer           `json:"layers"`
	Labels       map[string]string `json:"labels,omitempty"`
	Annotations  map[string]string `json:"annotations,omitempty"`
	Created      string            `json:"created,omitempty"`
	Entrypoint   []string          `json:"entrypoint,omitempty"`
	Cmd          []string          `json:"cmd,omitempty"`
	WorkingDir   string            `json:"workingDir,omitempty"`
	User         string            `json:"user,omitempty"`
	FetchedAt    time.Time         `json:"fetchedAt"`
}

type Repository struct {
	Repository      string               `json:"repository"`
	TagPattern      string               `json:"tagPattern"`
	CheckedAt       time.Time            `json:"checkedAt,omitzero"`
	NextCrawl       time.Time            `json:"nextCrawl,omitzero"`
	ListedTags      int                  `json:"listedTags"`
	MatchedTags     int                  `json:"matchedTags"`
	Errors          []string             `json:"errors,omitempty"`
	Images          []Image              `json:"images"`
	UnsupportedTags map[string]string    `json:"unsupportedTags,omitempty"`
	TagCheckedAt    map[string]time.Time `json:"tagCheckedAt,omitempty"`
}

type RepositorySummary struct {
	SkippedTags int       `json:"skippedTags,omitempty"`
	Repository  string    `json:"repository"`
	TagPattern  string    `json:"tagPattern"`
	CheckedAt   time.Time `json:"checkedAt,omitzero"`
	NextCrawl   time.Time `json:"nextCrawl,omitzero"`
	ListedTags  int       `json:"listedTags"`
	MatchedTags int       `json:"matchedTags"`
	ImageCount  int       `json:"imageCount"`
	Errors      []string  `json:"errors,omitempty"`
}

type RepositoryPage struct {
	RepositorySummary
	Images []Image `json:"images"`
	Offset int     `json:"offset"`
	Limit  int     `json:"limit"`
	Total  int     `json:"total"`
}

// Target has the same platform and ordered-layer fields as a scraped Image.
type Target struct {
	Digest   string   `json:"digest"`
	Platform Platform `json:"platform"`
	Layers   []Layer  `json:"layers"`
}

type Candidate struct {
	Repository string   `json:"repository"`
	Digest     string   `json:"digest"`
	Tags       []string `json:"tags"`
	Platform   Platform `json:"platform"`
	Created    string   `json:"created,omitempty"`
	Evidence   string   `json:"evidence"`
}

// Images at the same layer boundary are alternatives, never an ordered set
// of parents. A prefix match establishes shared layers, not Dockerfile FROM.
type Stage struct {
	LayerCount int         `json:"layerCount"`
	Candidates []Candidate `json:"candidates"`
	Truncated  bool        `json:"truncated"`
}

type Hierarchy struct {
	Digest     string   `json:"digest"`
	Platform   Platform `json:"platform"`
	LayerCount int      `json:"layerCount"`
	Root       string   `json:"root"`
	Stages     []Stage  `json:"stages"`
}

type HierarchyResult struct {
	Hierarchies []Hierarchy `json:"hierarchies"`
	Warnings    []string    `json:"warnings,omitempty"`
}
