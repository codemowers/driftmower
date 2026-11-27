package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/codemowers/driftmower/internal/lifecycle"
	"github.com/codemowers/driftmower/internal/scanner"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/findings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type lifecycleSource interface {
	Lifecycles(context.Context, []lifecycle.Query) (lifecycle.Result, error)
}
type packagesInput struct {
	Namespace      string `json:"namespace,omitempty"`
	WorkloadUID    string `json:"workloadUID,omitempty"`
	FrameworksOnly bool   `json:"frameworksOnly,omitempty"`
}
type packageInput struct {
	PURL      string `json:"purl"`
	Namespace string `json:"namespace,omitempty"`
}
type packageUse struct {
	Namespace string `json:"namespace"`
	Workload  string `json:"workload"`
	UID       string `json:"uid"`
	Kind      string `json:"kind"`
	Container string `json:"container"`
}
type packageOccurrence struct {
	scanner.Package
	Digest         string           `json:"digest"`
	PlatformDigest string           `json:"platformDigest"`
	Repository     string           `json:"repository"`
	Image          string           `json:"image"`
	ContainerImage string           `json:"containerImage"`
	Uses           []packageUse     `json:"uses"`
	Coverage       string           `json:"coverage"`
	Reason         string           `json:"reason,omitempty"`
	ScannedAt      string           `json:"scannedAt,omitempty"`
	SBOMURL        string           `json:"sbomUrl"`
	Lifecycle      *lifecycle.Match `json:"lifecycle,omitempty"`
}
type packageImageReference struct {
	Image      string `json:"image"`
	Repository string `json:"repository"`
	Digest     string `json:"digest"`
}

type packageSummary struct {
	UsedBy          []packageImageReference `json:"usedBy,omitempty"`
	LifecycleStates []string                `json:"lifecycleStates"`
	ID              string                  `json:"id"`
	Name            string                  `json:"name"`
	Ecosystem       string                  `json:"ecosystem"`
	Versions        int                     `json:"versions"`
	Images          int                     `json:"images"`
	Vulnerabilities int                     `json:"vulnerabilities"`
	Tags            []string                `json:"tags"`
	Lifecycle       *lifecycle.Match        `json:"lifecycle,omitempty"`
}
type packageCoverage struct {
	Images               int `json:"images"`
	Scanned              int `json:"scanned"`
	Partial              int `json:"partial"`
	Unavailable          int `json:"unavailable"`
	UnresolvedContainers int `json:"unresolvedContainers"`
}
type packagesOutput struct {
	Packages    []packageSummary    `json:"packages"`
	Occurrences []packageOccurrence `json:"occurrences,omitempty"`
	Coverage    packageCoverage     `json:"coverage"`
	Lifecycle   *lifecycle.Result   `json:"lifecycle,omitempty"`
	Warnings    []string            `json:"warnings,omitempty"`
}

func addPackageTools(s *mcp.Server, w *Workloads, mapping auth.Mapping, source FindingsSource) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_packages", Description: "Compact SBOM package inventory for running images: version, image and vulnerability counts, upstream lifecycle tags and links. Optional namespace/workloadUID scopes consumers; frameworksOnly returns classified framework signals, not proof of execution. Coverage gaps remain unknown.", InputSchema: inputSchema[packagesInput](nil), Annotations: readOnly("List SBOM packages")}, func(ctx context.Context, req *mcp.CallToolRequest, in packagesInput) (*mcp.CallToolResult, *packagesOutput, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out, err := readPackages(ctx, w, id, in, "", source)
		return nil, out, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "get_package", Description: "One version-independent package PURL: observed versions, immutable image/platform digests, consuming workloads and containers, licenses/paths, CVE/GHSA findings and lifecycle support facts. Full PURLs retain distro/architecture qualifiers.", InputSchema: inputSchema[packageInput](nil), Annotations: readOnly("Read SBOM package")}, func(ctx context.Context, req *mcp.CallToolRequest, in packageInput) (*mcp.CallToolResult, *packagesOutput, error) {
		if !strings.HasPrefix(in.PURL, "pkg:") || lifecycle.Identity(in.PURL) != in.PURL {
			return nil, nil, fmt.Errorf("provide a version-independent PURL")
		}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out, err := readPackages(ctx, w, id, packagesInput{Namespace: in.Namespace}, in.PURL, source)
		return nil, out, err
	})
}

type packageImage struct {
	image string
	uses  []packageUse
}
type artifactUse struct {
	digest, containerImage string
	ref                    scanReference
}

func readPackages(ctx context.Context, w *Workloads, id authz.Identity, in packagesInput, purl string, source FindingsSource) (*packagesOutput, error) {
	allowed, err := mayListImages(ctx, w.Judge, id)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("reading packages requires permission to list ContainerImages")
	}
	if in.WorkloadUID != "" && in.Namespace == "" {
		return nil, fmt.Errorf("workloadUID requires namespace")
	}
	inv, err := w.Cache.List(ctx, in.Namespace, id)
	if err != nil {
		return nil, err
	}
	pods, warnings, err := w.Cache.Pods(ctx, in.Namespace, id)
	if err != nil {
		return nil, err
	}
	out := &packagesOutput{Packages: []packageSummary{}, Warnings: append(slices.Clone(inv.Warnings), warnings...)}
	owners := map[string]packageUse{}
	for _, wl := range rootWorkloads(inv) {
		for _, pod := range wl.Pods {
			owners[wl.Namespace+"/"+pod] = packageUse{Namespace: wl.Namespace, Workload: wl.Name, UID: wl.UID, Kind: wl.Kind}
		}
	}
	running := map[string]*packageImage{}
	for _, pod := range pods {
		if pod.ScanPod || pod.Phase == "Succeeded" || pod.Phase == "Failed" {
			continue
		}
		use, ok := owners[pod.Namespace+"/"+pod.Name]
		if !ok {
			use = packageUse{Namespace: pod.Namespace, Workload: pod.Name, UID: pod.UID, Kind: "Pod"}
		}
		if in.WorkloadUID != "" && use.UID != in.WorkloadUID {
			continue
		}
		for _, container := range pod.Containers {
			d := container.ImageID
			if i := strings.LastIndex(d, "@"); i >= 0 {
				d = d[i+1:]
			} else {
				d = strings.TrimPrefix(d, "containerd://")
				d = strings.TrimPrefix(d, "docker://")
			}
			if !validDigest(d) {
				out.Coverage.UnresolvedContainers++
				continue
			}
			image := running[d]
			if image == nil {
				image = &packageImage{image: container.Image}
				running[d] = image
			}
			u := use
			u.Container = container.Name
			if !slices.Contains(image.uses, u) {
				image.uses = append(image.uses, u)
			}
		}
	}
	out.Coverage.Images = len(running)
	list, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	artifacts := map[string][]artifactUse{}
	resolved := map[string]bool{}
	expected := map[string]int{}
	loaded := map[string]int{}
	for d := range running {
		for i := range list.Items {
			refs, ok := scanRefs(&list.Items[i], d)
			if !ok {
				continue
			}
			expected[d] = len(refs)
			for _, ref := range refs {
				if validScanKey(ref.Key) {
					artifacts[ref.Key] = append(artifacts[ref.Key], artifactUse{digest: d, containerImage: list.Items[i].GetName(), ref: ref})
				}
			}
			break
		}
	}
	keys := slices.Sorted(maps.Keys(artifacts))
	if len(keys) == 0 {
		out.Coverage.Unavailable = len(running)
		return out, nil
	}
	projections, err := readPackageProjections(ctx, w, keys, purl, in.FrameworksOnly)
	if err != nil {
		return nil, err
	}
	all := []packageOccurrence{}
	partial := map[string]bool{}
	for _, key := range keys {
		projection := projections[key]
		if projection == nil {
			continue
		}
		for _, a := range artifacts[key] {
			resolved[a.digest] = true
			loaded[a.digest]++
			if projection.Coverage != "complete" {
				partial[a.digest] = true
			}
			for _, p := range projection.Packages {
				all = append(all, packageOccurrence{Repository: packageRepository(running[a.digest].image), Package: p, Digest: a.digest, PlatformDigest: a.ref.Digest, ContainerImage: a.containerImage, Image: running[a.digest].image, Uses: running[a.digest].uses, Coverage: projection.Coverage, Reason: projection.Reason, ScannedAt: projection.ScannedAt, SBOMURL: "/api/image-scans/sbom?" + url.Values{"image": {a.containerImage}, "digest": {a.ref.Digest}, "key": {key}}.Encode()})
			}
		}
	}
	for digest := range resolved {
		if loaded[digest] < expected[digest] {
			partial[digest] = true
		}
	}
	out.Coverage.Scanned = len(resolved)
	out.Coverage.Partial = len(partial)
	out.Coverage.Unavailable = len(running) - len(resolved)
	// The source crawler owns fetched upstream evidence; MCP only joins this response.
	if src, ok := source.(lifecycleSource); ok {
		queries := map[string]lifecycle.Query{}
		for _, p := range all {
			q := lifecycle.Query{PURL: p.ID, Version: p.Version}
			queries[q.Key()] = q
		}
		queryList := []lifecycle.Query{}
		for _, key := range slices.Sorted(maps.Keys(queries)) {
			queryList = append(queryList, queries[key])
		}
		result, err := src.Lifecycles(ctx, queryList)
		if err != nil {
			out.Warnings = append(out.Warnings, "Lifecycle metadata unavailable: "+err.Error())
		} else {
			for i := range all {
				q := lifecycle.Query{PURL: all[i].ID, Version: all[i].Version}
				if match, ok := result.Matches[q.Key()]; ok {
					all[i].Lifecycle = &match
				}
			}
			result.Matches = nil
			out.Lifecycle = &result
		}
	} else {
		out.Warnings = append(out.Warnings, "Lifecycle crawler is not configured.")
	}
	summaries := map[string]*packageSummary{}
	versions := map[string]map[string]bool{}
	images := map[string]map[string]bool{}
	cves := map[string]map[string]bool{}
	states := map[string]map[string]bool{}
	for _, p := range all {
		if in.FrameworksOnly && (p.Lifecycle == nil || (p.Lifecycle.Category != "framework" && !slices.Contains(p.Lifecycle.Tags, "frontend") && !slices.Contains(p.Lifecycle.Tags, "backend"))) {
			continue
		}
		row := summaries[p.ID]
		if row == nil {
			row = &packageSummary{ID: p.ID, Name: p.Name, Ecosystem: p.Ecosystem, Tags: []string{}, Lifecycle: p.Lifecycle}
			if p.Lifecycle != nil {
				row.Tags = p.Lifecycle.Tags
			}
			summaries[p.ID] = row
			versions[p.ID] = map[string]bool{}
			images[p.ID] = map[string]bool{}
			cves[p.ID] = map[string]bool{}
			states[p.ID] = map[string]bool{}
		}
		state := "unknown"
		if p.Lifecycle != nil {
			switch p.Lifecycle.State {
			case "supported", "maintenance":
				state = "supported"
			case "end-of-life":
				state = "end-of-life"
			}
		}
		states[p.ID][state] = true
		versions[p.ID][p.Version] = true
		images[p.ID][p.Digest] = true
		for _, v := range p.Findings {
			cves[p.ID][v.ID] = true
		}
		if purl != "" || in.FrameworksOnly {
			out.Occurrences = append(out.Occurrences, p)
		}
	}
	for _, key := range slices.Sorted(maps.Keys(summaries)) {
		p := summaries[key]
		p.Versions = len(versions[key])
		p.Images = len(images[key])
		p.Vulnerabilities = len(cves[key])
		p.LifecycleStates = slices.Sorted(maps.Keys(states[key]))
		refs := []packageImageReference{}
		for digest := range images[key] {
			image := running[digest]
			refs = append(refs, packageImageReference{Image: image.image, Repository: packageRepository(image.image), Digest: digest})
		}
		slices.SortFunc(refs, func(a, b packageImageReference) int {
			return strings.Compare(a.Repository+"@"+a.Digest, b.Repository+"@"+b.Digest)
		})
		p.UsedBy = refs[:min(3, len(refs))]
		if purl == "" && !in.FrameworksOnly && p.Lifecycle != nil {
			link := *p.Lifecycle
			link.State = "unknown"
			link.Cycle = ""
			link.EOL = ""
			link.Released = ""
			link.ActiveSupportEnd = ""
			link.Latest = ""
			p.Lifecycle = &link
		}
		out.Packages = append(out.Packages, *p)
	}
	slices.SortFunc(out.Occurrences, func(a, b packageOccurrence) int {
		return strings.Compare(a.ID+"\x00"+a.Version+"\x00"+a.Digest+"\x00"+a.PURL, b.ID+"\x00"+b.Version+"\x00"+b.Digest+"\x00"+b.PURL)
	})
	return out, nil
}
func readPackageProjections(ctx context.Context, w *Workloads, keys []string, purl string, details bool) (map[string]*scanner.ArtifactPackages, error) {
	key := strings.Join(keys, ",") + "\x00" + purl + fmt.Sprint(details)
	flight := w.packageReads.DoChan(key, func() (any, error) {
		return fetchPackageProjections(context.WithoutCancel(ctx), w, keys, purl, details)
	})
	select {
	case result := <-flight:
		if result.Err != nil {
			return nil, result.Err
		}
		return result.Val.(map[string]*scanner.ArtifactPackages), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func fetchPackageProjections(ctx context.Context, w *Workloads, keys []string, purl string, details bool) (map[string]*scanner.ArtifactPackages, error) {
	if w.ScanURL == "" {
		return nil, fmt.Errorf("scanner is not configured")
	}
	token, err := os.ReadFile(w.ScanTokenFile)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]any{"keys": keys, "purl": purl, "includeDetails": details})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(w.ScanURL, "/")+"/v1/packages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scanner answered %s", response.Status)
	}
	var result struct {
		Artifacts map[string]*scanner.ArtifactPackages `json:"artifacts"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 256<<20)).Decode(&result); err != nil {
		return nil, err
	}
	return result.Artifacts, nil
}

func packageRepository(image string) string {
	keys := findings.Keys(image)
	if len(keys) == 0 {
		return image
	}
	repo, _, _ := strings.Cut(keys[0], "@")
	if colon := strings.LastIndex(repo, ":"); colon > strings.LastIndex(repo, "/") {
		repo = repo[:colon]
	}
	return repo
}
