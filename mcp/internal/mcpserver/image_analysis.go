package mcpserver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/codemowers/driftmower/internal/imageanalysis"
	"github.com/codemowers/driftmower/internal/scanner"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type imageAnalysisInput struct {
	Digests        []string `json:"digests"`
	IncludeDetails bool     `json:"includeDetails,omitempty"`
}
type imageAnalysisArtifact struct {
	Digest        string                `json:"digest"`
	ConfigCreated string                `json:"configCreated,omitempty"`
	Status        string                `json:"status"`
	Analysis      *imageanalysis.Report `json:"analysis,omitempty"`
}

func addImageAnalysisTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_image_analysis", Title: "Read static image analysis", Description: "Full filesystem enumeration, MIME counts, the 1000 newest files with timestamps, latest file modification time and bounded ELF linking evidence and executable shell files at standard locations, without executing image code. Counts are partial if interrupted or unreadable. Missing analysis is unknown. Up to 16 digests.", InputSchema: inputSchema[imageAnalysisInput](nil), Annotations: readOnly("Read static image analysis")}, func(ctx context.Context, req *mcp.CallToolRequest, in imageAnalysisInput) (*mcp.CallToolResult, map[string]any, error) {
		if len(in.Digests) == 0 || len(in.Digests) > 16 {
			return nil, nil, fmt.Errorf("provide 1 to 16 digests")
		}
		for _, d := range in.Digests {
			if !validDigest(d) {
				return nil, nil, fmt.Errorf("invalid digest")
			}
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
			return nil, nil, fmt.Errorf("reading analysis requires permission to list ContainerImages")
		}
		list, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, nil, err
		}
		out := map[string][]imageAnalysisArtifact{}
		reports := map[string]*imageanalysis.Report{}
		reads := 0
		for _, d := range in.Digests {
			if _, done := out[d]; done {
				continue
			}
			out[d] = []imageAnalysisArtifact{}
			for i := range list.Items {
				refs, ok := scanRefs(&list.Items[i], d)
				if !ok {
					continue
				}
				if len(refs) > 16 {
					return nil, nil, fmt.Errorf("image has too many platforms; select a platform digest")
				}
				for _, ref := range refs {
					a := imageAnalysisArtifact{Digest: ref.Digest, Status: "pending"}
					a.ConfigCreated = imageConfigCreated(&list.Items[i], ref.Digest)
					if validScanKey(ref.AnalysisKey) {
						report, done := reports[ref.AnalysisKey]
						if !done {
							if reads >= 16 {
								return nil, nil, fmt.Errorf("too many platform analyses; select fewer digests")
							}
							reads++
							report = readImageAnalysis(ctx, w, ref.AnalysisKey)
							reports[ref.AnalysisKey] = report
						}
						a.Status = "unavailable"
						if report != nil {
							a.Status = "available"
							detail := *report
							if !in.IncludeDetails {
								detail.NewestFiles = nil
								detail.Binaries = nil
							}
							a.Analysis = &detail
						}
					}
					out[d] = append(out[d], a)
				}
				break
			}
		}
		return nil, map[string]any{"images": out}, nil
	})
}
func readImageAnalysis(ctx context.Context, w *Workloads, key string) *imageanalysis.Report {
	if w.ScanURL == "" || !validScanKey(key) {
		return nil
	}
	token, err := os.ReadFile(w.ScanTokenFile)
	if err != nil || strings.TrimSpace(string(token)) == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(w.ScanURL, "/")+"/v1/sboms/"+key, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, scanner.MaxSBOMBytes+1))
	if err != nil || len(body) > scanner.MaxSBOMBytes {
		return nil
	}
	report, err := imageanalysis.ReadCycloneDX(bytes.NewReader(body))
	if err != nil {
		return nil
	}
	return report
}
