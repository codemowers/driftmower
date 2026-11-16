package mcpserver

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/findings"
)

// ChangesSource is a FindingsSource that can also parse a source's later
// releases.
type ChangesSource interface {
	Changes(ctx context.Context, url, from string) (*crawler.ChangesReport, error)
}

type imageChangesInput struct {
	Image      string   `json:"image" jsonschema:"Image reference with a digest, such as ghcr.io/org/app@sha256:..., or the bare sha256:... digest"`
	Categories []string `json:"categories,omitempty" jsonschema:"Keep only these categories: security, breaking, bug, feature. Omit for every line."`
}

type imageChangesOutput struct {
	Image   string `json:"image"`
	Source  string `json:"source"`
	Version string `json:"version"`
	*crawler.ChangesReport
}

// resolveImage finds the deployed version an image reference or bare digest
// belongs to.
func resolveImage(reports []crawler.SourceReport, image string) (findings.Match, bool) {
	if strings.HasPrefix(image, "sha256:") {
		for i := range reports {
			for j := range reports[i].Deployed {
				d := &reports[i].Deployed[j]
				if slices.ContainsFunc(append(slices.Clone(d.References), d.Images...), func(ref string) bool { return strings.HasSuffix(ref, "@"+image) }) {
					return findings.Match{Source: &reports[i], Version: d}, true
				}
			}
		}
		return findings.Match{}, false
	}
	return findings.NewIndex(reports).Lookup(image)
}

func addImageChangesTool(s *mcp.Server, source FindingsSource, changes ChangesSource, w *Workloads, m auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_image_changes",
		Title: "What later releases change for an image",
		Description: "Use to see what upgrading an image would bring, such as which security fixes are in later versions. Resolves the image (by digest) to its source repository and deployed version, " +
			"then lists every newer stable release on the same tag prefix, newest first, with the lines of its release notes, or of the repository changelog where the notes list nothing, " +
			"each categorized security, breaking, bug or feature, and totals. Categories are read from headings, [TAGS], conventional-commit prefixes, CVE/GHSA identifiers and wording; " +
			"uncategorized lines have no category. Callers who may list ContainerImages may ask about any image; others about images their own workloads run.",
		InputSchema: inputSchema[imageChangesInput](func(p map[string]*jsonschema.Schema) {
			p["image"].MinLength, p["image"].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(512)
			p["categories"].Items.Enum = []any{crawler.CategorySecurity, crawler.CategoryBreaking, crawler.CategoryBug, crawler.CategoryFeature}
		}),
		Annotations: readOnly("What later releases change for an image"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in imageChangesInput) (*mcp.CallToolResult, *imageChangesOutput, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, err
		}
		reports, err := source.Reports(ctx)
		if err != nil {
			return nil, nil, errors.New("the crawler could not be reached")
		}
		match, ok := resolveImage(reports, strings.TrimSpace(in.Image))
		if !ok {
			return nil, nil, errors.New("the image is not matched to a crawled source version")
		}
		allImages, err := mayListImages(ctx, w.Judge, id)
		if err != nil {
			return nil, nil, err
		}
		if !allImages {
			inv, err := w.Cache.List(ctx, "", id)
			if err != nil {
				return nil, nil, err
			}
			runs := false
			index := findings.NewIndex(reports)
			for _, wl := range rootWorkloads(inv) {
				for _, image := range wl.Images {
					if found, ok := index.Lookup(image); ok && found.Version == match.Version {
						runs = true
					}
				}
			}
			if !runs {
				return nil, nil, errors.New("not authorized: none of your workloads run this image, and listing ContainerImages is not allowed")
			}
		}
		report, err := changes.Changes(ctx, match.Source.URL, match.Version.Version)
		if err != nil {
			return nil, nil, err
		}
		if len(in.Categories) > 0 {
			for i := range report.Versions {
				report.Versions[i].Items = slices.DeleteFunc(report.Versions[i].Items, func(item crawler.ChangeItem) bool { return !slices.Contains(in.Categories, item.Category) })
			}
		}

		return nil, &imageChangesOutput{Image: in.Image, Source: match.Source.URL, Version: match.Version.Version, ChangesReport: report}, nil
	})
}
