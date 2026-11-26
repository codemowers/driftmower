package dashboard

import (
	"context"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

// nodestatd records the images each node holds as ContainerImage objects;
// without its APIs Driftmower has no image inventory, drift or scans. A full
// one-click install adds it first, so MCP discovers the APIs when it starts.
const (
	nodestatdChart     = "oci://ghcr.io/codemowers/charts/nodestatd"
	nodestatdNamespace = "kube-system"
	k3sContainerd      = "/run/k3s/containerd/containerd.sock"
)

// NodestatdSetup is set when nodestatd's APIs are missing.
type NodestatdSetup struct {
	// k3s keeps containerd's socket elsewhere; the chart's default also
	// covers Talos and kubeadm.
	K3s     bool   `json:"k3s,omitempty"`
	Command string `json:"command"`
	// crio when every node runs CRI-O; empty for containerd. One nodestatd
	// release serves one runtime and the chart does not detect it.
	Runtime string `json:"runtime,omitempty"`
	// Set when nodestatd cannot run here, such as nodes mixing runtimes or
	// one it does not read; Install then skips it.
	Unsupported string `json:"unsupported,omitempty"`
}

func nodestatdSetup(ctx context.Context, client kubernetes.Interface, kubeContext string) *NodestatdSetup {
	if servesResource(client, "codemowers.io/v1alpha1", "containerimages") && servesResource(client, "codemowers.io/v1alpha1", "sourcerepositories") {
		return nil
	}
	setup := &NodestatdSetup{}
	if nodes, err := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{}); err == nil && len(nodes.Items) > 0 {
		setup.K3s = strings.Contains(nodes.Items[0].Status.NodeInfo.KubeletVersion, "k3s")
		runtimes := map[string]string{} // runtime name -> an example node
		for _, node := range nodes.Items {
			name, _, _ := strings.Cut(node.Status.NodeInfo.ContainerRuntimeVersion, "://")
			runtimes[name] = node.Name
		}
		switch {
		case len(runtimes) == 1 && runtimes["cri-o"] != "":
			setup.Runtime = "crio"
		case len(runtimes) == 1 && runtimes["containerd"] != "":
		case len(runtimes) > 1:
			setup.Unsupported = "nodestatd serves one container runtime per cluster, but these nodes mix " + strings.Join(sortedKeys(runtimes), " and ") + "; Driftmower will have no image inventory, drift, advisories or scans here"
		default:
			for name, node := range runtimes {
				setup.Unsupported = "nodestatd reads containerd or CRI-O, but node " + node + " runs " + name + "; Driftmower will have no image inventory, drift, advisories or scans here"
			}
		}
	}
	setup.Command = "helm " + strings.Join(quoteAll(nodestatdArgs("", kubeContext, "", setup.K3s, setup.Runtime)), " ")
	return setup
}

func nodestatdArgs(kubeconfig, kubeContext, version string, k3s bool, runtime string) []string {
	args := []string{"upgrade", "--install", "nodestatd", nodestatdChart}
	if version != "" {
		args = append(args, "--version", version)
	}
	if kubeconfig != "" {
		args = append(args, "--kubeconfig", kubeconfig)
	}
	args = append(args, "--kube-context", kubeContext, "--namespace", nodestatdNamespace)
	switch {
	case runtime != "":
		args = append(args, "--set", "runtime="+runtime)
	case k3s:
		args = append(args, "--set", "containerd.socket="+k3sContainerd)
	}
	return args
}

// chartVersion resolves the version helm would install now, so the install
// pins exactly that release.
func chartVersion(ctx context.Context, helm, chartRef string) (string, error) {
	metadata, err := showChart(ctx, helm, chartRef, "chart")
	if err != nil {
		return "", err
	}
	var chart struct {
		Version string `json:"version"`
	}
	if err := yaml.Unmarshal(metadata, &chart); err != nil {
		return "", err
	}
	return chart.Version, nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// nodestatdSupportsRuntime reports whether the nodestatd chart version
// selects a container runtime; releases before CRI-O support do not, and on
// CRI-O nodes their Pods would wait forever for containerd's socket.
func nodestatdSupportsRuntime(ctx context.Context, helm, version string) (bool, error) {
	defaults, err := showChart(ctx, helm, nodestatdChart, "values", "--version", version)
	if err != nil {
		return false, err
	}
	var tree map[string]any
	if err := yaml.Unmarshal(defaults, &tree); err != nil {
		return false, err
	}
	return definesValue(tree, []string{"runtime"}), nil
}
