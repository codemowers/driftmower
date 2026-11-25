package dashboard

import (
	"context"
	"fmt"
	"os"
	"os/exec"
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
func checkChart(ctx context.Context, helm string, values []string) (string, error) {
	show := func(what string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, helm, append([]string{"show", what, installChart}, args...)...)
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
	defaults, err := show("values", "--version", chart.Version)
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
	if len(missing) > 0 {
		return "", fmt.Errorf("the published Driftmower chart %s predates this desktop: it does not define %s. Install a newer chart release, or a desktop matching this one", chart.Version, strings.Join(missing, ", "))
	}
	return chart.Version, nil
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
