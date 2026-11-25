package dashboard

import (
	"context"
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
	// Set when nodestatd cannot run here: it reads containerd's socket, so
	// nodes with another runtime such as CRI-O are skipped by Install.
	Unsupported string `json:"unsupported,omitempty"`
}

func nodestatdSetup(ctx context.Context, client kubernetes.Interface, kubeContext string) *NodestatdSetup {
	if servesResource(client, "codemowers.io/v1alpha1", "containerimages") && servesResource(client, "codemowers.io/v1alpha1", "sourcerepositories") {
		return nil
	}
	setup := &NodestatdSetup{}
	if nodes, err := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{}); err == nil && len(nodes.Items) > 0 {
		setup.K3s = strings.Contains(nodes.Items[0].Status.NodeInfo.KubeletVersion, "k3s")
		for _, node := range nodes.Items {
			runtime := node.Status.NodeInfo.ContainerRuntimeVersion
			if runtime != "" && !strings.HasPrefix(runtime, "containerd://") {
				name, _, _ := strings.Cut(runtime, "://")
				setup.Unsupported = "nodestatd reads containerd's socket, but node " + node.Name + " runs " + name + "; Driftmower will have no image inventory, drift, advisories or scans here"
				break
			}
		}
	}
	setup.Command = "helm " + strings.Join(quoteAll(nodestatdArgs("", kubeContext, "", setup.K3s)), " ")
	return setup
}

func nodestatdArgs(kubeconfig, kubeContext, version string, k3s bool) []string {
	args := []string{"upgrade", "--install", "nodestatd", nodestatdChart}
	if version != "" {
		args = append(args, "--version", version)
	}
	if kubeconfig != "" {
		args = append(args, "--kubeconfig", kubeconfig)
	}
	args = append(args, "--kube-context", kubeContext, "--namespace", nodestatdNamespace)
	if k3s {
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
