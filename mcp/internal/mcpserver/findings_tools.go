package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/findings"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

// FindingsSource returns driftmower-crawler's source reports.
type FindingsSource interface {
	Reports(ctx context.Context) ([]crawler.SourceReport, error)
}

// Every ContainerImage, and so every source, is visible to callers who may
// list them; others see the versions their own workloads run.
var listContainerImages = authz.Attributes{Verb: "list", Group: "codemowers.io", Resource: "containerimages"}

type sourceFindingsInput struct {
	URL          string `json:"url,omitempty" jsonschema:"Source repository URL, such as https://github.com/cert-manager/cert-manager"`
	AffectedOnly bool   `json:"affectedOnly,omitempty" jsonschema:"Only sources with a deployed version an advisory affects"`
}

type workloadFindingsInput struct {
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty" jsonschema:"Root workload name; requires namespace"`
}

type workloadRef struct {
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
}

type advisoryFinding struct {
	Advisory   string             `json:"advisory"`
	Severity   string             `json:"severity,omitempty"`
	Confidence crawler.Confidence `json:"confidence"`
	FixedIn    string             `json:"fixedIn,omitempty"`
	Summary    string             `json:"summary,omitempty"`
	URL        string             `json:"url,omitempty"`
}

type versionFindings struct {
	Version      string            `json:"version"`
	Behind       int               `json:"behind"`
	LatestOnLine string            `json:"latestOnLine,omitempty"`
	Findings     []advisoryFinding `json:"findings,omitempty"`
	Workloads    []workloadRef     `json:"workloads,omitempty"`
	Images       []string          `json:"images,omitempty"`
}

type sourceFindings struct {
	Releases  []crawler.Release `json:"releases,omitempty"`
	URL       string            `json:"url"`
	CheckedAt time.Time         `json:"checkedAt,omitzero"`
	Latest    string            `json:"latest,omitempty"`
	Errors    []string          `json:"errors,omitempty"`
	Deployed  []versionFindings `json:"deployed"`
}

type sourceFindingsOutput struct {
	Sources  []sourceFindings `json:"sources"`
	Warnings []string         `json:"warnings,omitempty"`
}

type imageFindings struct {
	Image        string            `json:"image"`
	Source       string            `json:"source"`
	Version      string            `json:"version"`
	Behind       int               `json:"behind"`
	LatestOnLine string            `json:"latestOnLine,omitempty"`
	Latest       string            `json:"latest,omitempty"`
	Findings     []advisoryFinding `json:"findings,omitempty"`
	// The source's last crawl, and what it could not fetch. Without
	// CheckedAt, or with errors, the absence of findings means nothing.
	CheckedAt time.Time `json:"checkedAt,omitzero"`
	Errors    []string  `json:"errors,omitempty"`
}

type workloadFindings struct {
	workloadRef
	Images    []imageFindings `json:"images,omitempty"`
	Untracked []string        `json:"untracked,omitempty"`
}

type workloadFindingsOutput struct {
	Workloads []workloadFindings `json:"workloads"`
	Warnings  []string           `json:"warnings,omitempty"`
}

// expand adds advisory summaries and links to a version's findings.
func expand(report *crawler.SourceReport, deployed *crawler.DeployedVersion) []advisoryFinding {
	advisories := map[string]crawler.Advisory{}
	for _, a := range report.Advisories {
		advisories[a.ID] = a
	}
	var out []advisoryFinding
	for _, f := range deployed.Findings {
		a := advisories[f.Advisory]
		out = append(out, advisoryFinding{Advisory: f.Advisory, Severity: f.Severity, Confidence: f.Confidence, FixedIn: f.FixedIn, Summary: a.Summary, URL: a.URL})
	}

	return out
}

func affected(deployed *crawler.DeployedVersion) bool {
	return slices.ContainsFunc(deployed.Findings, func(f crawler.Finding) bool { return f.Confidence == crawler.Affected })
}

// unchecked reports whether a source has not been fully crawled: never, or
// with errors, so its drift and advisories may be missing.
func unchecked(report *crawler.SourceReport) bool {
	return report.CheckedAt.IsZero() || len(report.Errors) > 0
}

func latestTag(report *crawler.SourceReport) string {
	if report.Latest != nil {
		return report.Latest.Tag
	}

	return ""
}

func addFindingsTools(s *mcp.Server, source FindingsSource, w *Workloads, m auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_source_findings",
		Title: "Get version drift and security advisories by source",
		Description: "With a specific source URL, also includes stable release notes and links. Lists the source repositories of images in use with, per deployed version, how many stable releases it is behind, " +
			"the newest release on its own major.minor line, the security advisories that apply (severity, confidence, the version " +
			"that fixes it, summary and link) and the root workloads running it. Confidence affected means a well-formed range or OSV " +
			"matched the version; possible means a free-text range admits a reading that includes it. Behind -1 means the version " +
			"cannot be compared: it does not parse, or no release on its line is known yet. A source without checkedAt, or with errors, " +
			"was not fully crawled, and the absence of findings for it means nothing. Advisories come from GitHub repository advisories, GitHub's reviewed advisory database and OSV; " +
			"sources off GitHub get no repository advisories, and OSV by version covers Go modules only, so absence of findings is " +
			"not proof of absence. Callers who may list ContainerImages see every source and image; others see only the versions, " +
			"workloads and image references of workloads they may list. Data is crawled every few hours; check checkedAt and errors.",
		InputSchema:  inputSchema[sourceFindingsInput](nil),
		OutputSchema: schemaFor[*sourceFindingsOutput](),
		Annotations:  readOnly("Get version drift and security advisories by source"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in sourceFindingsInput) (*mcp.CallToolResult, *sourceFindingsOutput, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("findings require an authenticated caller: %w", err)
		}
		reports, err := source.Reports(ctx)
		if err != nil {
			return nil, nil, errors.New("findings are unavailable: the crawler could not be reached")
		}
		inv, err := w.Cache.List(ctx, "", id)
		if err != nil {
			return nil, nil, err
		}
		allImages, err := mayListImages(ctx, w.Judge, id)
		if err != nil {
			return nil, nil, err
		}

		index := findings.NewIndex(reports)
		running := map[*crawler.DeployedVersion][]workloadRef{}
		// The reference forms of the images the caller's own workloads run.
		visible := map[string]bool{}
		for _, wl := range rootWorkloads(inv) {
			seen := map[*crawler.DeployedVersion]bool{}
			for _, image := range wl.Images {
				match, ok := index.Lookup(image)
				if !ok {
					continue
				}
				for _, key := range findings.Keys(image) {
					visible[key] = true
				}
				if !seen[match.Version] {
					seen[match.Version] = true
					running[match.Version] = append(running[match.Version], workloadRef{Namespace: wl.Namespace, Kind: wl.Kind, Name: wl.Name})
				}
			}
		}

		out := &sourceFindingsOutput{Sources: []sourceFindings{}}
		for i := range reports {
			report := &reports[i]
			if in.URL != "" && report.URL != in.URL {
				continue
			}
			src := sourceFindings{URL: report.URL, CheckedAt: report.CheckedAt, Latest: latestTag(report), Errors: report.Errors}
			if in.URL != "" {
				src.Releases = report.Releases
			}
			for j := range report.Deployed {
				deployed := &report.Deployed[j]
				if (!allImages && len(running[deployed]) == 0) || (in.AffectedOnly && !affected(deployed)) {
					continue
				}
				v := versionFindings{Version: deployed.Version, Behind: deployed.Behind,
					LatestOnLine: deployed.LatestOnLine, Findings: expand(report, deployed), Workloads: running[deployed], Images: deployed.Images}
				if !allImages {
					// A version's images span the cluster. Another namespace's
					// references, such as a private registry named after it,
					// stay hidden from a caller who may not list them.
					v.Images = slices.DeleteFunc(slices.Clone(v.Images), func(image string) bool {
						return !slices.ContainsFunc(findings.Keys(image), func(key string) bool { return visible[key] })
					})
				}
				src.Deployed = append(src.Deployed, v)
			}
			if len(src.Deployed) > 0 {
				out.Sources = append(out.Sources, src)
			}
		}
		if !allImages {
			out.Warnings = append(out.Warnings, "Listing ContainerImages is not authorized; only versions run by workloads you may list are shown.")
		}
		out.Warnings = append(out.Warnings, inv.Warnings...)

		affectedSources, uncheckedSources := 0, 0
		for _, src := range out.Sources {
			if slices.ContainsFunc(src.Deployed, func(v versionFindings) bool {
				return slices.ContainsFunc(v.Findings, func(f advisoryFinding) bool { return f.Confidence == crawler.Affected })
			}) {
				affectedSources++
			}
			if src.CheckedAt.IsZero() || len(src.Errors) > 0 {
				uncheckedSources++
			}
		}
		summary := fmt.Sprintf("%d sources; %d with a deployed version an advisory affects.", len(out.Sources), affectedSources)
		if uncheckedSources > 0 {
			summary += fmt.Sprintf(" %d not fully crawled yet or with errors; their findings may be incomplete.", uncheckedSources)
		}

		return text(summary), out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_workload_findings",
		Title: "Get version drift and security advisories by workload",
		Description: "For root workloads the caller may list, the images they run resolved to source, deployed version, drift and " +
			"applicable advisories, as in get_source_findings, with each source's checkedAt and errors: an image without checkedAt, or " +
			"with errors, was not fully checked, so no findings does not mean none apply. Images whose source or version is unknown " +
			"are listed as untracked. " +
			"Use it to judge what a workload is exposed to and which version to move to; find where the version is declared, such " +
			"as a GitOps repository, before proposing a change.",
		InputSchema: inputSchema[workloadFindingsInput](func(props map[string]*jsonschema.Schema) {
			namespaceProperty(props["namespace"])
		}),
		OutputSchema: schemaFor[*workloadFindingsOutput](),
		Annotations:  readOnly("Get version drift and security advisories by workload"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in workloadFindingsInput) (*mcp.CallToolResult, *workloadFindingsOutput, error) {
		if in.Name != "" && in.Namespace == "" {
			return nil, nil, errors.New("name requires namespace")
		}
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("findings require an authenticated caller: %w", err)
		}
		reports, err := source.Reports(ctx)
		if err != nil {
			return nil, nil, errors.New("findings are unavailable: the crawler could not be reached")
		}
		inv, err := w.Cache.List(ctx, in.Namespace, id)
		if err != nil {
			return nil, nil, err
		}

		index := findings.NewIndex(reports)
		out := &workloadFindingsOutput{Workloads: []workloadFindings{}, Warnings: inv.Warnings}
		exposed, incomplete := 0, 0
		for _, wl := range rootWorkloads(inv) {
			if in.Name != "" && wl.Name != in.Name {
				continue
			}
			entry := workloadFindings{workloadRef: workloadRef{Namespace: wl.Namespace, Kind: wl.Kind, Name: wl.Name}}
			for _, image := range wl.Images {
				match, ok := index.Lookup(image)
				if !ok {
					entry.Untracked = append(entry.Untracked, image)
					continue
				}
				entry.Images = append(entry.Images, imageFindings{Image: image, Source: match.Source.URL, Version: match.Version.Version,
					Behind: match.Version.Behind, LatestOnLine: match.Version.LatestOnLine, Latest: latestTag(match.Source),
					Findings: expand(match.Source, match.Version), CheckedAt: match.Source.CheckedAt, Errors: match.Source.Errors})
				if unchecked(match.Source) {
					incomplete++
				}
			}
			if slices.ContainsFunc(entry.Images, func(i imageFindings) bool { return len(i.Findings) > 0 }) {
				exposed++
			}
			out.Workloads = append(out.Workloads, entry)
		}

		summary := fmt.Sprintf("%d workloads; %d run an image with advisory findings.", len(out.Workloads), exposed)
		if incomplete > 0 {
			summary += fmt.Sprintf(" %d images were not fully checked: their source is not crawled yet or its crawl had errors.", incomplete)
		}
		if len(inv.Warnings) > 0 {
			summary += " " + strings.Join(inv.Warnings, " ")
		}

		return text(summary), out, nil
	})
}

// rootWorkloads skips the per-namespace buckets of unclaimed resources.
func rootWorkloads(inv *workloads.Inventory) []*workloads.Workload {
	return slices.DeleteFunc(slices.Clone(inv.Workloads), func(w *workloads.Workload) bool { return w.Kind == "Namespace" })
}

func mayListImages(ctx context.Context, judge authz.Judge, id authz.Identity) (bool, error) {
	switch j := judge.MayPerform(ctx, id, listContainerImages); j.Verdict {
	case authz.Yes:
		return true, nil
	case authz.No:
		return false, nil
	default:
		return false, fmt.Errorf("authorization checks failed; retry later: %s", j.Reason)
	}
}
