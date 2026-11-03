package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/codemowers/driftmower/operator/internal/authz"
	"github.com/codemowers/driftmower/operator/internal/crawler"
	"github.com/codemowers/driftmower/operator/internal/findings"
)

var findingsTools = []map[string]any{{
	"name":  "get_source_findings",
	"title": "Get version drift and security advisories by source",
	"description": "Lists the source repositories of images in use with, per deployed version, how many stable releases it is behind, " +
		"the newest release on its own major.minor line, the security advisories that apply (severity, confidence, the version " +
		"that fixes it, summary and link) and the root workloads running it. Confidence affected means a well-formed range or OSV " +
		"matched the version; possible means a free-text range admits a reading that includes it. Behind -1 means the version " +
		"cannot be compared. Advisories come from GitHub repository advisories, GitHub's reviewed advisory database and OSV; " +
		"sources off GitHub get no repository advisories, and OSV by version covers Go modules only, so absence of findings is " +
		"not proof of absence. Callers who may list ContainerImages see every source; others see the versions their visible " +
		"workloads run. Data is crawled every few hours; check checkedAt and errors.",
	"inputSchema": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
		"url":          map[string]any{"type": "string", "description": "Source repository URL, such as https://github.com/cert-manager/cert-manager"},
		"affectedOnly": map[string]any{"type": "boolean", "description": "Only sources with a deployed version an advisory affects"},
	}},
	"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
}, {
	"name":  "get_workload_findings",
	"title": "Get version drift and security advisories by workload",
	"description": "For root workloads the caller may list, the images they run resolved to source, deployed version, drift and " +
		"applicable advisories, as in get_source_findings. Images whose source or version is unknown are listed as untracked. " +
		"Use it to judge what a workload is exposed to and which version to move to; find where the version is declared, such " +
		"as a GitOps repository, before proposing a change.",
	"inputSchema": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
		"namespace": map[string]any{"type": "string", "maxLength": 63, "pattern": namespacePattern.String()},
		"name":      map[string]any{"type": "string", "description": "Root workload name; requires namespace"},
	}},
	"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
}}

type workloadRef struct {
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
}

type finding struct {
	Advisory   string             `json:"advisory"`
	Severity   string             `json:"severity,omitempty"`
	Confidence crawler.Confidence `json:"confidence"`
	FixedIn    string             `json:"fixedIn,omitempty"`
	Summary    string             `json:"summary,omitempty"`
	URL        string             `json:"url,omitempty"`
}

type versionFindings struct {
	Version      string        `json:"version"`
	Behind       int           `json:"behind"`
	LatestOnLine string        `json:"latestOnLine,omitempty"`
	Findings     []finding     `json:"findings,omitempty"`
	Workloads    []workloadRef `json:"workloads,omitempty"`
	Images       []string      `json:"images,omitempty"`
}

type sourceFindings struct {
	URL       string            `json:"url"`
	CheckedAt time.Time         `json:"checkedAt,omitzero"`
	Latest    string            `json:"latest,omitempty"`
	Errors    []string          `json:"errors,omitempty"`
	Deployed  []versionFindings `json:"deployed"`
}

// expand adds advisory summaries and links to a version's findings.
func expand(report *crawler.SourceReport, deployed *crawler.DeployedVersion) []finding {
	advisories := map[string]crawler.Advisory{}
	for _, a := range report.Advisories {
		advisories[a.ID] = a
	}
	var out []finding
	for _, f := range deployed.Findings {
		a := advisories[f.Advisory]
		out = append(out, finding{Advisory: f.Advisory, Severity: f.Severity, Confidence: f.Confidence, FixedIn: f.FixedIn, Summary: a.Summary, URL: a.URL})
	}
	return out
}

func affected(deployed *crawler.DeployedVersion) bool {
	return slices.ContainsFunc(deployed.Findings, func(f crawler.Finding) bool { return f.Confidence == crawler.Affected })
}

func latestTag(report *crawler.SourceReport) string {
	if report.Latest != nil {
		return report.Latest.Tag
	}
	return ""
}

func (s *Server) getSourceFindings(ctx context.Context, id *authz.Identity, raw json.RawMessage) map[string]any {
	var input struct {
		URL          string `json:"url"`
		AffectedOnly bool   `json:"affectedOnly"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &input) != nil {
		return toolError("invalid arguments")
	}
	reports, err := s.Findings.Reports(ctx)
	if err != nil {
		s.Log.Error("crawler unavailable", "error", err)
		return toolError("findings are unavailable: the crawler could not be reached")
	}
	inventory, err := s.getWorkloads(ctx, id, "")
	if err != nil {
		return toolError("authorization checks failed; retry later")
	}
	allImages, err := s.Authorizer.Allowed(ctx, id, authz.Attributes{Group: "codemowers.io", Resource: "containerimages", Verb: "list"})
	if err != nil {
		return toolError("authorization checks failed; retry later")
	}
	index := findings.NewIndex(reports)
	running := map[*crawler.DeployedVersion][]workloadRef{}
	for _, w := range inventory.Workloads {
		if w.Kind == "Namespace" {
			continue
		}
		seen := map[*crawler.DeployedVersion]bool{}
		for _, image := range w.Images {
			if match, ok := index.Lookup(image); ok && !seen[match.Version] {
				seen[match.Version] = true
				running[match.Version] = append(running[match.Version], workloadRef{Namespace: w.Namespace, Kind: w.Kind, Name: w.Name})
			}
		}
	}
	result := map[string]any{"sources": []sourceFindings{}}
	var sources []sourceFindings
	for i := range reports {
		report := &reports[i]
		if input.URL != "" && report.URL != input.URL {
			continue
		}
		source := sourceFindings{URL: report.URL, CheckedAt: report.CheckedAt, Latest: latestTag(report), Errors: report.Errors}
		for j := range report.Deployed {
			deployed := &report.Deployed[j]
			if (!allImages && len(running[deployed]) == 0) || (input.AffectedOnly && !affected(deployed)) {
				continue
			}
			source.Deployed = append(source.Deployed, versionFindings{Version: deployed.Version, Behind: deployed.Behind,
				LatestOnLine: deployed.LatestOnLine, Findings: expand(report, deployed), Workloads: running[deployed], Images: deployed.Images})
		}
		if len(source.Deployed) > 0 {
			sources = append(sources, source)
		}
	}
	if sources != nil {
		result["sources"] = sources
	}
	var warnings []string
	if !allImages {
		warnings = append(warnings, "Listing ContainerImages is not authorized; only versions run by workloads you may list are shown.")
	}
	warnings = append(warnings, inventory.Warnings...)
	if len(warnings) > 0 {
		result["warnings"] = warnings
	}
	affectedCount := 0
	for _, source := range sources {
		if slices.ContainsFunc(source.Deployed, func(v versionFindings) bool {
			return slices.ContainsFunc(v.Findings, func(f finding) bool { return f.Confidence == crawler.Affected })
		}) {
			affectedCount++
		}
	}
	text := fmt.Sprintf("%d sources; %d with a deployed version an advisory affects.", len(sources), affectedCount)
	return map[string]any{"structuredContent": result, "content": []map[string]any{{"type": "text", "text": text}}}
}

type imageFindings struct {
	Image        string    `json:"image"`
	Source       string    `json:"source"`
	Version      string    `json:"version"`
	Behind       int       `json:"behind"`
	LatestOnLine string    `json:"latestOnLine,omitempty"`
	Latest       string    `json:"latest,omitempty"`
	Findings     []finding `json:"findings,omitempty"`
}

type workloadFindings struct {
	workloadRef
	Images    []imageFindings `json:"images,omitempty"`
	Untracked []string        `json:"untracked,omitempty"`
}

func (s *Server) getWorkloadFindings(ctx context.Context, id *authz.Identity, raw json.RawMessage) map[string]any {
	var input struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &input) != nil {
		return toolError("invalid arguments")
	}
	if input.Namespace != "" && (len(input.Namespace) > 63 || !namespacePattern.MatchString(input.Namespace)) {
		return toolError("invalid namespace")
	}
	if input.Name != "" && input.Namespace == "" {
		return toolError("name requires namespace")
	}
	reports, err := s.Findings.Reports(ctx)
	if err != nil {
		s.Log.Error("crawler unavailable", "error", err)
		return toolError("findings are unavailable: the crawler could not be reached")
	}
	inventory, err := s.getWorkloads(ctx, id, input.Namespace)
	if err != nil {
		return toolError("authorization checks failed; retry later")
	}
	index := findings.NewIndex(reports)
	out := []workloadFindings{}
	exposed := 0
	for _, w := range inventory.Workloads {
		if w.Kind == "Namespace" || (input.Name != "" && w.Name != input.Name) {
			continue
		}
		entry := workloadFindings{workloadRef: workloadRef{Namespace: w.Namespace, Kind: w.Kind, Name: w.Name}}
		for _, image := range w.Images {
			match, ok := index.Lookup(image)
			if !ok {
				entry.Untracked = append(entry.Untracked, image)
				continue
			}
			entry.Images = append(entry.Images, imageFindings{Image: image, Source: match.Source.URL, Version: match.Version.Version,
				Behind: match.Version.Behind, LatestOnLine: match.Version.LatestOnLine, Latest: latestTag(match.Source),
				Findings: expand(match.Source, match.Version)})
		}
		if slices.ContainsFunc(entry.Images, func(i imageFindings) bool { return len(i.Findings) > 0 }) {
			exposed++
		}
		out = append(out, entry)
	}
	result := map[string]any{"workloads": out}
	if len(inventory.Warnings) > 0 {
		result["warnings"] = inventory.Warnings
	}
	text := fmt.Sprintf("%d workloads; %d run an image with advisory findings.", len(out), exposed)
	if len(inventory.Warnings) > 0 {
		text += " " + strings.Join(inventory.Warnings, " ")
	}
	return map[string]any{"structuredContent": result, "content": []map[string]any{{"type": "text", "text": text}}}
}
