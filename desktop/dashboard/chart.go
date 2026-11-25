package dashboard

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

// checkChart resolves the chart version helm would install and verifies that
// it defines every value one-click install sets. Helm accepts unknown values
// silently, so an older published chart would otherwise install without, for
// example, its CA bundle or port-forward-only policy. Install then pins the
// checked version.
//
// A local chart (see localInstallChart) is checked the same way but not
// pinned, since it has no published version.
func checkChart(ctx context.Context, helm, chartRef string, values []string) (string, error) {
	if chartRef == "" {
		chartRef = installChart
	}
	show := func(what string, args ...string) ([]byte, error) {
		return showChart(ctx, helm, chartRef, what, args...)
	}
	metadata, err := show("chart")
	if err != nil {
		return "", err
	}
	var chart struct {
		Version string `json:"version"`
	}
	if err := yaml.Unmarshal(metadata, &chart); err != nil || chart.Version == "" {
		return "", fmt.Errorf("read the Driftmower chart version: %v", err)
	}
	var defaults []byte
	if chartRef == installChart {
		defaults, err = show("values", "--version", chart.Version)
	} else {
		defaults, err = show("values")
	}
	if err != nil {
		return "", err
	}
	var tree map[string]any
	if err := yaml.Unmarshal(defaults, &tree); err != nil {
		return "", fmt.Errorf("read the Driftmower chart values: %w", err)
	}
	var missing []string
	for _, value := range values {
		path, _, _ := strings.Cut(value, "=")
		if !definesValue(tree, strings.Split(path, ".")) {
			missing = append(missing, path)
		}
	}
	if len(missing) > 0 && chartRef != installChart {
		return "", fmt.Errorf("the Driftmower chart at %s does not define %s", chartRef, strings.Join(missing, ", "))
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("the published Driftmower chart %s predates this desktop: it does not define %s. Install a newer chart release, or a desktop matching this one", chart.Version, strings.Join(missing, ", "))
	}
	if chartRef != installChart {
		return "", nil
	}
	return chart.Version, nil
}

// localInstallChart is a developer-only override: an absolute path to a chart
// directory, such as this repository's chart/, that one-click install uses
// instead of the published chart. Its images come from the latest published
// release (see releaseImages), since a source chart names unbuilt images.
func localInstallChart() string {
	dir := os.Getenv("DRIFTMOWER_INSTALL_CHART")
	if dir == "" {
		return ""
	}
	if absolute, err := filepath.Abs(dir); err == nil {
		return absolute
	}
	return dir
}

// releaseImages reads the immutable image references the latest published
// chart pins, as values to set on a local chart.
func releaseImages(ctx context.Context, helm string) ([]string, error) {
	defaults, err := showChart(ctx, helm, installChart, "values")
	if err != nil {
		return nil, err
	}
	var tree map[string]any
	if err := yaml.Unmarshal(defaults, &tree); err != nil {
		return nil, fmt.Errorf("read the published chart values: %w", err)
	}
	var values []string
	for _, path := range []string{"crawler.image", "mcp.image", "operator.image", "operator.databaseImage", "operator.trivyImage", "ui.image", "registryScraper.image"} {
		keys := strings.Split(path, ".")
		node, ok := tree[keys[0]].(map[string]any)
		if !ok {
			continue
		}
		if image, ok := node[keys[1]].(string); ok && image != "" {
			values = append(values, path+"="+image)
		}
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("the published Driftmower chart names no images")
	}
	return values, nil
}

func showChart(ctx context.Context, helm, chartRef, what string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, helm, append([]string{"show", what, chartRef}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+pluginPath())
	output, err := cmd.Output()
	if err != nil {
		message := err.Error()
		if exit, ok := err.(*exec.ExitError); ok && len(exit.Stderr) > 0 {
			message = lastLine(strings.TrimSpace(string(exit.Stderr)))
		}
		return nil, fmt.Errorf("read the Driftmower chart: %s", message)
	}
	return output, nil
}

func definesValue(tree map[string]any, path []string) bool {
	value, ok := tree[path[0]]
	if !ok {
		return false
	}
	if len(path) == 1 {
		return true
	}
	child, ok := value.(map[string]any)
	return ok && definesValue(child, path[1:])
}

// storageClasses lists StorageClass names and the cluster default, if any.
func storageClasses(ctx context.Context, client kubernetes.Interface) ([]string, string) {
	list, err := client.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, ""
	}
	var names []string
	defaultClass := ""
	for _, class := range list.Items {
		names = append(names, class.Name)
		for _, key := range []string{"storageclass.kubernetes.io/is-default-class", "storageclass.beta.kubernetes.io/is-default-class"} {
			if class.Annotations[key] == "true" {
				defaultClass = class.Name
			}
		}
	}
	sort.Strings(names)
	return names, defaultClass
}
