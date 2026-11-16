package mcpserver

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type helmReleaseInput struct {
	Namespace string `json:"namespace" jsonschema:"Namespace the release is installed in"`
	Name      string `json:"name" jsonschema:"Helm release name"`
}

type helmManifestDocument struct {
	Index     int    `json:"index"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Source    string `json:"source"`
	LineCount int    `json:"lineCount"`
	Text      string `json:"text"`
}

type helmReleaseContent struct {
	Name            string                 `json:"name"`
	Namespace       string                 `json:"namespace"`
	Revision        int                    `json:"revision"`
	Status          string                 `json:"status"`
	ChartName       string                 `json:"chartName"`
	ChartVersion    string                 `json:"chartVersion"`
	ChartAppVersion string                 `json:"chartAppVersion"`
	Overrides       map[string]any         `json:"overrides"`
	Defaults        map[string]any         `json:"defaults"`
	Documents       []helmManifestDocument `json:"documents"`
	TotalLines      int                    `json:"totalLines"`
}

// storedRelease is the part of Helm's release record this tool reads.
type storedRelease struct {
	Name      string                  `json:"name"`
	Namespace string                  `json:"namespace"`
	Version   int                     `json:"version"`
	Info      struct{ Status string } `json:"info"`
	Config    map[string]any          `json:"config"`
	Manifest  string                  `json:"manifest"`
	Chart     struct {
		Metadata struct {
			Name       string `json:"name"`
			Version    string `json:"version"`
			AppVersion string `json:"appVersion"`
		} `json:"metadata"`
		Values map[string]any `json:"values"`
	} `json:"chart"`
}

func addHelmReleaseTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_helm_release",
		Title: "Read a Helm release's values and manifest",
		Description: "Read the deployed revision of one Helm release from its release Secret: the values set at install or upgrade (overrides), the chart's defaults, " +
			"and the rendered manifest split into documents. Requires the caller to get that Secret. Values under keys that name passwords, tokens, secrets or credentials, " +
			"and the data of rendered Secrets, are redacted.",
		InputSchema: inputSchema[helmReleaseInput](func(p map[string]*jsonschema.Schema) {
			p["namespace"].MinLength = jsonschema.Ptr(1)
			p["name"].MinLength = jsonschema.Ptr(1)
		}),
		Annotations: readOnly("Read a Helm release's values and manifest"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in helmReleaseInput) (*mcp.CallToolResult, *helmReleaseContent, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out, err := readHelmRelease(ctx, w, id, in.Namespace, in.Name)

		return nil, out, err
	})
}

func readHelmRelease(ctx context.Context, w *Workloads, id authz.Identity, namespace, name string) (*helmReleaseContent, error) {
	secrets, err := w.Metadata.Resource(helmSecretsGVR).Namespace(namespace).List(ctx, metav1.ListOptions{LabelSelector: "owner=helm,name=" + name})
	if err != nil {
		return nil, fmt.Errorf("list Helm release Secrets: %w", err)
	}
	// The deployed revision, else the newest.
	secretName, best, deployed := "", 0, false
	for _, s := range secrets.Items {
		revision, err := strconv.Atoi(s.Labels["version"])
		if err != nil || s.Name != "sh.helm.release.v1."+name+".v"+strconv.Itoa(revision) {
			continue
		}
		isDeployed := s.Labels["status"] == "deployed"
		if (isDeployed && !deployed) || (isDeployed == deployed && revision > best) {
			secretName, best, deployed = s.Name, revision, isDeployed
		}
	}
	if secretName == "" {
		return nil, fmt.Errorf("no Helm release storage found for %s/%s", namespace, name)
	}
	if j := w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: namespace, Resource: "secrets", Verb: "get", Name: secretName}); j.Verdict != authz.Yes {
		return nil, fmt.Errorf("not authorized to get Secret %s/%s, which holds the release", namespace, secretName)
	}
	list, err := w.Cache.Kubernetes.CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("metadata.name", secretName).String()})
	if err != nil {
		return nil, fmt.Errorf("read Secret %s/%s: %w", namespace, secretName, err)
	}
	var payload []byte
	found := false
	for _, item := range list.Items {
		if item.Name == secretName {
			payload, found = item.Data["release"], true
		}
	}
	if !found {
		return nil, fmt.Errorf("secret %s/%s disappeared", namespace, secretName)
	}
	release, err := decodeHelmRelease(payload)
	if err != nil {
		return nil, fmt.Errorf("decode %s/%s: %w", namespace, secretName, err)
	}

	out := &helmReleaseContent{Name: release.Name, Namespace: release.Namespace, Revision: release.Version, Status: release.Info.Status,
		ChartName: release.Chart.Metadata.Name, ChartVersion: release.Chart.Metadata.Version, ChartAppVersion: release.Chart.Metadata.AppVersion,
		Overrides: redactValues(release.Config), Defaults: redactValues(release.Chart.Values), Documents: splitManifest(release.Manifest)}
	for _, d := range out.Documents {
		out.TotalLines += d.LineCount
	}

	return out, nil
}

// Helm stores a release as base64 of (usually gzipped) JSON.
func decodeHelmRelease(payload []byte) (*storedRelease, error) {
	if len(payload) == 0 {
		return nil, errors.New("no release data")
	}
	raw, err := base64.StdEncoding.DecodeString(string(payload))
	if err != nil {
		return nil, err
	}
	if len(raw) > 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		// Rendered manifests stay far below this.
		if raw, err = io.ReadAll(io.LimitReader(zr, 64<<20)); err != nil {
			return nil, err
		}
	}
	var r storedRelease
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.Config == nil {
		r.Config = map[string]any{}
	}
	if r.Chart.Values == nil {
		r.Chart.Values = map[string]any{}
	}

	return &r, nil
}

const redacted = "[redacted]"

var (
	sensitiveKey = regexp.MustCompile(`(password|passwd|secret|token|apikey|privatekey|credentials?|auth)$`)
	referenceKey = regexp.MustCompile(`^existing`)
	keySeparator = strings.NewReplacer("-", "", "_", "", ".", "")
)

// redactValues hides scalars under keys that name secrets; `existing…`
// keys name a Secret rather than hold one.
func redactValues(values map[string]any) map[string]any {
	out, _ := redactValue(values).(map[string]any)

	return out
}

func redactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			key := keySeparator.Replace(strings.ToLower(k))
			if sensitiveKey.MatchString(key) && !referenceKey.MatchString(key) && isSecretScalar(child) {
				out[k] = redacted
			} else {
				out[k] = redactValue(child)
			}
		}

		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = redactValue(child)
		}

		return out
	}

	return v
}

func isSecretScalar(v any) bool {
	switch t := v.(type) {
	case string:
		return t != ""
	case float64, int, int64:
		return true
	}

	return false
}

var (
	documentSeparator = regexp.MustCompile(`(?m)^---\s*$`)
	sourceComment     = regexp.MustCompile(`(?m)^# Source:\s*(\S+)`)
	documentKind      = regexp.MustCompile(`(?m)^kind:[ \t]*(\S+)`)
	documentName      = regexp.MustCompile(`(?m)^metadata:\n(?:[ \t]+.*\n)*?[ \t]+name:[ \t]*(\S+)`)
	dataBlock         = regexp.MustCompile(`^(data|stringData):`)
	dataEntry         = regexp.MustCompile(`^(\s+)([^:]+):\s*\S`)
)

// splitManifest splits a rendered manifest into its documents, with
// rendered Secrets' data redacted.
func splitManifest(manifest string) []helmManifestDocument {
	docs := []helmManifestDocument{}
	for _, chunk := range documentSeparator.Split(manifest, -1) {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		var body []string
		for _, line := range strings.Split(chunk, "\n") {
			if !strings.HasPrefix(line, "# Source:") {
				body = append(body, line)
			}
		}
		text := strings.TrimSpace(strings.Join(body, "\n"))
		if text == "" {
			continue
		}
		d := helmManifestDocument{Index: len(docs), Kind: "Document"}
		if m := documentKind.FindStringSubmatch(text); m != nil {
			d.Kind = m[1]
		}
		if d.Kind == "Secret" {
			text = redactSecretData(text)
		}
		if m := documentName.FindStringSubmatch(text); m != nil {
			d.Name = m[1]
		}
		if m := sourceComment.FindStringSubmatch(chunk); m != nil {
			d.Source = m[1]
		}
		d.Text, d.LineCount = text, strings.Count(text, "\n")+1
		docs = append(docs, d)
	}

	return docs
}

func redactSecretData(text string) string {
	lines := strings.Split(text, "\n")
	inData := false
	for i, line := range lines {
		if dataBlock.MatchString(line) {
			inData = true

			continue
		}
		if inData && line != "" && line[0] != ' ' && line[0] != '\t' {
			inData = false
		}
		if inData {
			if m := dataEntry.FindStringSubmatch(line); m != nil {
				lines[i] = m[1] + m[2] + ": " + redacted
			}
		}
	}

	return strings.Join(lines, "\n")
}
