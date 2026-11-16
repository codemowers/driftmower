package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/codemowers/driftmower/internal/scanner"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type imageScanInput struct {
	Image  string `json:"image"`
	Digest string `json:"digest"`
}

func addImageScanTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_image_scan", Title: "Read image vulnerability scan", Description: "Read existing CycloneDX Trivy results for a ContainerImage digest. Requires permission to list ContainerImages. Distinguishes pending scans, expired cache artifacts and unavailable scanner access.", InputSchema: inputSchema[imageScanInput](func(props map[string]*jsonschema.Schema) {
		props["image"].Pattern = `^sha256-[a-f0-9]{64}$`
		props["digest"].Pattern = `^sha256:[a-f0-9]{64}$`
	}), Annotations: readOnly("Read image scan")}, func(ctx context.Context, req *mcp.CallToolRequest, in imageScanInput) (*mcp.CallToolResult, map[string]any, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		allowed, err := mayListImages(ctx, w.Judge, id)
		if err != nil {
			return nil, nil, err
		}
		if !allowed {
			return nil, nil, fmt.Errorf("reading image scans requires permission to list ContainerImages")
		}
		images, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + in.Image})
		if err != nil {
			return nil, nil, err
		}
		if len(images.Items) != 1 {
			return nil, nil, fmt.Errorf("ContainerImage is no longer available")
		}
		image := &images.Items[0]
		manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
		artifacts := []map[string]any{}
		valid := false
		for _, ref := range []string{strings.Replace(in.Image, "sha256-", "sha256:", 1)} {
			if ref == in.Digest {
				valid = true
			}
		}
		for _, raw := range manifests {
			if m, ok := raw.(map[string]any); ok && m["digest"] == in.Digest {
				valid = true
			}
		}
		refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
		for _, ref := range refs {
			if strings.HasSuffix(ref, "@"+in.Digest) {
				valid = true
			}
		}
		if !valid {
			return nil, nil, fmt.Errorf("digest does not belong to the selected ContainerImage")
		}
		for _, raw := range manifests {
			manifest, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			digest, _ := manifest["digest"].(string)
			if digest == "" {
				continue
			}
			// A platform request reads only that platform; an index request includes
			// its installed platform manifests, without claiming unscanned ones are clean.
			platformRequest := false
			for _, candidate := range manifests {
				if m, ok := candidate.(map[string]any); ok && m["digest"] == in.Digest {
					platformRequest = true
				}
			}
			if platformRequest && digest != in.Digest {
				continue
			}
			key := image.GetAnnotations()["driftmower.io/sbom-"+scanner.Key(digest, "manifest")[:40]]
			artifact := map[string]any{"digest": digest, "status": "pending"}
			if key != "" {
				artifact["key"] = key
				status, bom := readScan(ctx, w.ScanURL, w.ScanTokenFile, key)
				artifact["status"] = status
				if bom != nil {
					artifact["bom"] = bom
				}
			}
			artifacts = append(artifacts, artifact)
		}
		return nil, map[string]any{"image": in.Image, "digest": in.Digest, "artifacts": artifacts}, nil
	})
}

func readScan(ctx context.Context, baseURL, tokenFile, key string) (string, json.RawMessage) {
	if baseURL == "" {
		return "unavailable", nil
	}
	if len(key) != 64 || strings.Trim(key, "0123456789abcdef") != "" {
		return "invalid", nil
	}
	token, err := os.ReadFile(tokenFile)
	if err != nil || len(strings.TrimSpace(string(token))) == 0 {
		return "unavailable", nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/sboms/"+key, nil)
	if err != nil {
		return "unavailable", nil
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return "unavailable", nil
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return "expired", nil
	}
	if response.StatusCode != http.StatusOK {
		return "unavailable", nil
	}
	const limit = scanner.MaxSBOMBytes
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(body) > limit {
		return "unavailable", nil
	}
	var header struct {
		BOMFormat  string                 `json:"bomFormat"`
		Properties []scanner.ScanProperty `json:"properties"`
	}
	if json.Unmarshal(body, &header) != nil || header.BOMFormat != "CycloneDX" {
		return "invalid", nil
	}
	coverage, _, _ := scanner.ScanCoverage(header.Properties)
	if coverage == "partial" {
		return "partial", compactScan(body)
	}
	return "complete", compactScan(body)
}

// The dashboard needs findings and affected package identities, not the full
// dependency graph, hashes and license inventory from every image SBOM.
func compactScan(body []byte) json.RawMessage {
	var source map[string]json.RawMessage
	_ = json.Unmarshal(body, &source)
	result := map[string]any{"bomFormat": "CycloneDX", "metadata": source["metadata"], "properties": source["properties"]}
	var vulnerabilities []map[string]json.RawMessage
	_ = json.Unmarshal(source["vulnerabilities"], &vulnerabilities)
	used := map[string]bool{}
	rows := []map[string]json.RawMessage{}
	for _, v := range vulnerabilities {
		row := map[string]json.RawMessage{}
		for _, key := range []string{"id", "description", "ratings", "recommendation", "advisories", "published", "updated", "affects"} {
			if value, ok := v[key]; ok {
				row[key] = value
			}
		}
		var affects []struct {
			Ref string `json:"ref"`
		}
		_ = json.Unmarshal(v["affects"], &affects)
		for _, a := range affects {
			used[a.Ref] = true
		}
		rows = append(rows, row)
	}
	result["vulnerabilities"] = rows
	var components []map[string]json.RawMessage
	_ = json.Unmarshal(source["components"], &components)
	packages := []map[string]json.RawMessage{}
	for _, c := range components {
		var ref, purl string
		_ = json.Unmarshal(c["bom-ref"], &ref)
		_ = json.Unmarshal(c["purl"], &purl)
		if !used[ref] && !used[purl] {
			continue
		}
		item := map[string]json.RawMessage{}
		for _, key := range []string{"bom-ref", "name", "version", "purl", "properties"} {
			if value, ok := c[key]; ok {
				item[key] = value
			}
		}
		packages = append(packages, item)
	}
	result["components"] = packages
	compact, _ := json.Marshal(result)
	return compact
}
