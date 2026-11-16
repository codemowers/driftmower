package mcpserver

import (
	"context"
	"fmt"
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
		URL    string `json:"url"`
		Offset int    `json:"offset,omitempty"`
		Limit  int    `json:"limit,omitempty"`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "list_source_images", Title: "Source repository images in this cluster", Description: "List this cluster's ContainerImages built from one source repository, including unused images and unknown versions. Requires cluster-wide list ContainerImages. Image associations never come from the shared crawler. Limit defaults to 100, maximum 100; follow nextOffset.", InputSchema: inputSchema[input](nil), Annotations: readOnly("Source repository images")}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, *crawler.SourceImages, error) {
		if in.Limit == 0 {
			in.Limit = 100
		}
		if !httpURL(in.URL) || in.Offset < 0 || in.Limit < 1 || in.Limit > 100 {
			return nil, nil, fmt.Errorf("source URL and limit 1 to 100 are required")
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
		rows := []crawler.SourceImage{}
		for _, image := range images.Items {
			source, _, _ := unstructured.NestedString(image.Object, "status", "source")
			if source != in.URL {
				continue
			}
			row := crawler.SourceImage{Name: image.GetName(), References: []string{}}
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
		slices.SortFunc(rows, func(a, b crawler.SourceImage) int { return strings.Compare(a.Name, b.Name) })
		start := min(in.Offset, len(rows))
		end := min(start+in.Limit, len(rows))
		out := &crawler.SourceImages{Images: rows[start:end], Total: len(rows)}
		if end < len(rows) {
			out.NextOffset = &end
		}
		return text(fmt.Sprintf("%d images from this cluster.", out.Total)), out, nil
	})
}
