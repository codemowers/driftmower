package mcpserver

import (
	"context"
	"fmt"
	"github.com/codemowers/driftmower/internal/imagesource"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func addLocalSourceImagesTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	type input struct {
		URL string `json:"url"`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "list_source_images", Title: "Source repository images in this cluster", Description: "This cluster's ContainerImages built from one source repository.", InputSchema: inputSchema[input](nil), Annotations: readOnly("Source repository images")}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, *crawler.SourceImages, error) {
		if !httpURL(in.URL) {
			return nil, nil, fmt.Errorf("a source repository URL is required")
		}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		if w.Judge.MayPerform(ctx, id, authz.Attributes{Verb: "list", Group: "codemowers.io", Resource: "containerimages"}).Verdict != authz.Yes {
			return nil, nil, fmt.Errorf("ContainerImage inventory is not authorized")
		}
		images, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, nil, err
		}
		objects := make([]map[string]any, len(images.Items))
		for i := range images.Items {
			objects[i] = images.Items[i].Object
		}
		index := imagesource.NewIndex(objects)
		rows := []crawler.SourceImage{}
		for _, image := range images.Items {
			// Images whose claim is inherited from a base image's metadata
			// were not built from this repository.
			claim := imagesource.Of(image.Object, index)
			if claim.Source != in.URL {
				continue
			}
			row := crawler.SourceImage{Name: image.GetName(), References: []string{}}
			if strings.HasPrefix(row.Name, "sha256-") {
				row.Digest = strings.Replace(row.Name, "sha256-", "sha256:", 1)
			}
			row.Image, _, _ = unstructured.NestedString(image.Object, "status", "image")
			row.Version = claim.Version
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
		slices.SortFunc(rows, func(a, b crawler.SourceImage) int { return strings.Compare(a.Name, b.Name) })
		return text(fmt.Sprintf("%d images from this cluster.", len(rows))), &crawler.SourceImages{Images: rows}, nil
	})
}
