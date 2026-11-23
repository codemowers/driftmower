package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/codemowers/driftmower/internal/scanner"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type imageScanInput struct {
	Image  string `json:"image"`
	Digest string `json:"digest"`
}
type scanReference struct{ Digest, Key, AnalysisKey string }

func validScanKey(key string) bool {
	return len(key) == 64 && strings.Trim(key, "0123456789abcdef") == ""
}

// imageScanReferences authorizes the caller and resolves one image/digest pair
// to its scan artifacts. A cache key alone never grants access.
func imageScanReferences(ctx context.Context, w *Workloads, id authz.Identity, in imageScanInput) ([]scanReference, error) {
	allowed, err := mayListImages(ctx, w.Judge, id)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("reading image scans requires permission to list ContainerImages")
	}
	if !strings.HasPrefix(in.Image, "sha256-") || !validScanKey(strings.TrimPrefix(in.Image, "sha256-")) || !validDigest(in.Digest) {
		return nil, fmt.Errorf("invalid image or digest")
	}
	images, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + in.Image})
	if err != nil {
		return nil, err
	}
	if len(images.Items) != 1 {
		return nil, fmt.Errorf("ContainerImage is no longer available")
	}
	refs, ok := scanRefs(&images.Items[0], in.Digest)
	if !ok {
		return nil, fmt.Errorf("digest does not belong to the selected ContainerImage")
	}
	return refs, nil
}

func validDigest(d string) bool {
	return strings.HasPrefix(d, "sha256:") && validScanKey(strings.TrimPrefix(d, "sha256:"))
}

// scanRefs lists the scan artifacts of digest within image: one platform
// manifest, or every platform for the image's own digest.
func scanRefs(image *unstructured.Unstructured, digest string) ([]scanReference, bool) {
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	valid := strings.Replace(image.GetName(), "sha256-", "sha256:", 1) == digest
	platform := false
	for _, raw := range manifests {
		if manifest, ok := raw.(map[string]any); ok && manifest["digest"] == digest {
			valid, platform = true, true
		}
	}
	refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
	for _, ref := range refs {
		if strings.HasSuffix(ref, "@"+digest) {
			valid = true
		}
	}
	if !valid {
		return nil, false
	}
	out := []scanReference{}
	for _, raw := range manifests {
		manifest, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		d, _ := manifest["digest"].(string)
		if d == "" || platform && d != digest {
			continue
		}
		out = append(out, scanReference{Digest: d, Key: image.GetAnnotations()["driftmower.io/sbom-"+scanner.Key(d, "manifest")[:40]], AnalysisKey: image.GetAnnotations()["driftmower.io/analysis-"+scanner.Key(d, "manifest")[:40]]})
	}
	return out, true
}

type imageScansInput struct {
	Digests         []string `json:"digests" jsonschema:"Running image digests"`
	IncludeFindings bool     `json:"includeFindings,omitempty" jsonschema:"Add each completed scan's vulnerability findings"`
}

type imageScan struct {
	ContainerImage string           `json:"containerImage,omitempty"`
	Artifacts      []map[string]any `json:"artifacts"`
}

func addImageScanTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_image_scans", Title: "Read image vulnerability scans", Description: "Trivy scan status and SBOM URL per platform for running image digests; unfinished scans carry attempts and the latest failure reason. includeFindings adds each scan's vulnerabilities: id, severity, score, package, installed and fixed version.", InputSchema: inputSchema[imageScansInput](nil), Annotations: readOnly("Read image scans")}, func(ctx context.Context, req *mcp.CallToolRequest, in imageScansInput) (*mcp.CallToolResult, map[string]any, error) {
		if len(in.Digests) == 0 {
			return nil, nil, fmt.Errorf("provide at least one digest")
		}
		wanted := map[string]bool{}
		for _, d := range in.Digests {
			if !validDigest(d) {
				return nil, nil, fmt.Errorf("invalid sha256 digest")
			}
			wanted[d] = true
		}
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
		list, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, nil, err
		}
		out := map[string]imageScan{}
		for i := range list.Items {
			image := &list.Items[i]
			for d := range wanted {
				if _, done := out[d]; done {
					continue
				}
				refs, ok := scanRefs(image, d)
				if !ok {
					continue
				}
				scan := imageScan{ContainerImage: image.GetName(), Artifacts: []map[string]any{}}
				for _, ref := range refs {
					artifact := map[string]any{"digest": ref.Digest, "status": "pending"}
					switch {
					case ref.Key == "":
						if validScanKey(ref.AnalysisKey) {
							artifact["key"] = ref.AnalysisKey
							artifact["filesystemOnly"] = true
							artifact["url"] = "/api/image-scans/sbom?" + url.Values{"image": {image.GetName()}, "digest": {ref.Digest}, "key": {ref.AnalysisKey}}.Encode()
						}
						if p, ok := scanner.ScanProgress(image, ref.Digest); ok {
							artifact["attempts"] = p.Attempts
							if p.Reason != "" {
								artifact["reason"] = p.Reason
							}
							if p.Exhausted {
								artifact["status"] = "failed"
							} else if p.InFlight {
								artifact["status"] = "scanning"
							}
						}
					case !validScanKey(ref.Key):
						artifact["status"] = "invalid"
					default:
						artifact["status"] = "available"
						artifact["key"] = ref.Key
						artifact["url"] = "/api/image-scans/sbom?" + url.Values{"image": {image.GetName()}, "digest": {ref.Digest}, "key": {ref.Key}}.Encode()
					}
					scan.Artifacts = append(scan.Artifacts, artifact)
				}
				out[d] = scan
			}
		}
		if in.IncludeFindings {
			attachFindings(ctx, w, out)
		}
		return text(fmt.Sprintf("%d of %d digests resolved.", len(out), len(wanted))), map[string]any{"images": out}, nil
	})
}

// Stream the operator's exact gzip bytes through the caller's existing MCP
// authentication and RBAC. Explicit Accept-Encoding disables Go's transparent
// decompression; this proxy never recompresses or retains an artifact.
func serveImageScan(wr http.ResponseWriter, r *http.Request, w *Workloads, id authz.Identity) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		wr.Header().Set("Allow", "GET, HEAD")
		http.Error(wr, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	key := query.Get("key")
	if w == nil || !validScanKey(key) {
		http.NotFound(wr, r)
		return
	}
	refs, err := imageScanReferences(r.Context(), w, id, imageScanInput{Image: query.Get("image"), Digest: query.Get("digest")})
	if err != nil {
		http.Error(wr, "image scan unavailable or not permitted", http.StatusForbidden)
		return
	}
	matched := false
	for _, ref := range refs {
		if (ref.Key == key || ref.AnalysisKey == key) && ref.Digest == query.Get("digest") {
			matched = true
		}
	}
	if !matched {
		http.NotFound(wr, r)
		return
	}
	token, err := os.ReadFile(w.ScanTokenFile)
	if err != nil || strings.TrimSpace(string(token)) == "" || w.ScanURL == "" {
		http.Error(wr, "scanner unavailable", http.StatusServiceUnavailable)
		return
	}
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, strings.TrimRight(w.ScanURL, "/")+"/v1/sboms/"+key, nil)
	if err != nil {
		http.Error(wr, "scanner unavailable", http.StatusServiceUnavailable)
		return
	}
	upstream.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	encoding := r.Header.Get("Accept-Encoding")
	if encoding == "" {
		encoding = "gzip"
	}
	upstream.Header.Set("Accept-Encoding", encoding)
	for _, name := range []string{"If-None-Match", "If-Modified-Since"} {
		if value := r.Header.Get(name); value != "" {
			upstream.Header.Set(name, value)
		}
	}
	client := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(upstream)
	if err != nil {
		http.Error(wr, "scanner unavailable", http.StatusServiceUnavailable)
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNotModified {
		http.Error(wr, "scan artifact unavailable", response.StatusCode)
		return
	}
	if response.StatusCode == http.StatusOK && response.Header.Get("Content-Encoding") != "gzip" {
		http.Error(wr, "scanner did not return gzip", http.StatusBadGateway)
		return
	}
	if response.ContentLength > scanner.MaxCompressedSBOMBytes {
		http.Error(wr, "artifact exceeds compressed size limit", http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Type", "Content-Encoding", "Content-Length", "ETag", "Last-Modified"} {
		if value := response.Header.Get(name); value != "" {
			wr.Header().Set(name, value)
		}
	}
	wr.Header().Set("Cache-Control", "private, no-cache")
	wr.Header().Set("Vary", "Authorization, Origin, Accept-Encoding")
	wr.WriteHeader(response.StatusCode)
	if r.Method != http.MethodHead && response.StatusCode == http.StatusOK {
		_, _ = io.Copy(wr, io.LimitReader(response.Body, scanner.MaxCompressedSBOMBytes+1))
	}
}

// attachFindings asks the scanner once for every available artifact. An
// artifact the scanner no longer holds is expired; an unreachable scanner
// leaves every artifact unavailable, never clean.
func attachFindings(ctx context.Context, w *Workloads, scans map[string]imageScan) {
	keys := []string{}
	for _, scan := range scans {
		for _, artifact := range scan.Artifacts {
			if key, ok := artifact["key"].(string); ok && artifact["status"] == "available" {
				keys = append(keys, key)
			}
		}
	}
	if len(keys) == 0 {
		return
	}
	found, err := readFindings(ctx, w.ScanURL, w.ScanTokenFile, keys)
	for _, scan := range scans {
		for _, artifact := range scan.Artifacts {
			key, ok := artifact["key"].(string)
			if !ok || artifact["status"] != "available" {
				continue
			}
			switch findings := found[key]; {
			case err != nil:
				artifact["status"] = "unavailable"
			case findings == nil:
				artifact["status"] = "expired"
			default:
				artifact["status"] = "complete"
				if findings.Coverage == "partial" {
					artifact["status"] = "partial"
				}
				artifact["findings"] = findings
			}
		}
	}
}

func readFindings(ctx context.Context, baseURL, tokenFile string, keys []string) (map[string]*scanner.ArtifactFindings, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("scanner is not configured")
	}
	token, err := os.ReadFile(tokenFile)
	if err != nil || len(strings.TrimSpace(string(token))) == 0 {
		return nil, fmt.Errorf("scanner token unavailable")
	}
	body, err := json.Marshal(map[string][]string{"keys": keys})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/findings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scanner answered %s", response.Status)
	}
	var out struct {
		Artifacts map[string]*scanner.ArtifactFindings `json:"artifacts"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 256<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return out.Artifacts, nil
}
