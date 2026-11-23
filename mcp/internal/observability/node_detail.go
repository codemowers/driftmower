package observability

import (
	"context"
	"errors"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/kube"
)

type NodeDetailInput struct {
	Name string `json:"name" jsonschema:"Kubernetes Node name"`
}

type NodeDetail struct {
	Node              ClusterNode        `json:"node"`
	Labels            map[string]string  `json:"labels"`
	PersistentVolumes []PersistentVolume `json:"persistentVolumes"`
	VolumesAvailable  bool               `json:"volumesAvailable"`
	Warnings          []string           `json:"warnings"`
}

// GetNode returns one node and volumes with matching host-specific required
// affinity. Zone affinity and Pod placement do not imply host ownership.
func (s *Service) GetNode(ctx context.Context, id authz.Identity, in NodeDetailInput) (*NodeDetail, error) {
	if in.Name == "" {
		return nil, errors.New("node name is required")
	}
	if err := s.require(ctx, id, authz.Attributes{Resource: "nodes", Verb: "get", Name: in.Name}, "Kubernetes RBAC denied get node"); err != nil {
		return nil, err
	}
	node, err := s.Kubernetes.CoreV1().Nodes().Get(ctx, in.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	out := &NodeDetail{Node: describeNodes([]corev1.Node{*node})[0], Labels: node.Labels, PersistentVolumes: []PersistentVolume{}, Warnings: []string{}}
	if out.Labels == nil {
		out.Labels = map[string]string{}
	}
	if err := s.require(ctx, id, authz.Attributes{Resource: "persistentvolumes", Verb: "list"}, "Kubernetes RBAC denied list persistentvolumes; host volumes are unavailable"); err != nil {
		out.Warnings = append(out.Warnings, err.Error())
	} else {
		volumes, err := kube.Collect(ctx, func(ctx context.Context, opts metav1.ListOptions) ([]corev1.PersistentVolume, string, error) {
			list, err := s.Kubernetes.CoreV1().PersistentVolumes().List(ctx, opts)
			if err != nil {
				return nil, "", err
			}
			return list.Items, list.Continue, nil
		}, kube.ListOptions{What: "Node PV listing"})
		if err != nil {
			out.Warnings = append(out.Warnings, "Host volumes unavailable: "+err.Error())
		} else {
			out.VolumesAvailable = true
			for _, volume := range volumes {
				if volumeOnHost(volume.Spec.NodeAffinity, node) {
					out.PersistentVolumes = append(out.PersistentVolumes, describePV(&volume))
				}
			}
			slices.SortFunc(out.PersistentVolumes, func(a, b PersistentVolume) int { return strings.Compare(a.Name, b.Name) })
		}
	}
	if !s.MetricsEnabled() {
		return out, nil
	}
	identities := `max by (instance,node) (node_uname_info{node!=""} or label_replace(node_uname_info{node=""}, "node", "$1", "nodename", "(.+)"))`
	query := `max by (node) (max by (instance) (node_boot_time_seconds) * on (instance) group_left (node) (` + identities + `)) and on (node) kube_node_info{node=` + promString(in.Name) + `}`
	usage, err := s.snapshot(ctx, s.Backend, map[string]definition{"bootTime": {"seconds", query}}, true, nil, nil)
	if err != nil {
		out.Warnings = append(out.Warnings, "Last boot unavailable: "+err.Error())
	} else if metric := usage.Metrics["bootTime"]; metric != nil {
		if metric.Error != "" {
			out.Warnings = append(out.Warnings, "Last boot unavailable: "+metric.Error)
		}
		for _, sample := range metric.Breakdown {
			if sample.Labels["node"] == in.Name && sample.Value > 0 && sample.Value <= float64(s.now().Unix()) {
				value := sample.Value
				out.Node.BootTimeSeconds = &value
			}
		}
	}
	return out, nil
}

func volumeOnHost(affinity *corev1.VolumeNodeAffinity, node *corev1.Node) bool {
	if affinity == nil || affinity.Required == nil {
		return false
	}
	for _, term := range affinity.Required.NodeSelectorTerms {
		matches, host := true, false
		for _, expr := range term.MatchExpressions {
			matches = matches && nodeRequirementMatches(expr, node.Labels)
			if expr.Operator == corev1.NodeSelectorOpIn && (expr.Key == corev1.LabelHostname || strings.HasSuffix(expr.Key, "/node") || strings.HasSuffix(expr.Key, "/nodeid")) {
				host = true
			}
		}
		for _, expr := range term.MatchFields {
			matches = matches && expr.Key == "metadata.name" && nodeRequirementMatches(expr, map[string]string{"metadata.name": node.Name})
			if expr.Key == "metadata.name" && expr.Operator == corev1.NodeSelectorOpIn {
				host = true
			}
		}
		if matches && host {
			return true
		}
	}
	return false
}

func nodeRequirementMatches(expr corev1.NodeSelectorRequirement, values map[string]string) bool {
	operators := map[corev1.NodeSelectorOperator]selection.Operator{
		corev1.NodeSelectorOpIn: selection.In, corev1.NodeSelectorOpNotIn: selection.NotIn,
		corev1.NodeSelectorOpExists: selection.Exists, corev1.NodeSelectorOpDoesNotExist: selection.DoesNotExist,
		corev1.NodeSelectorOpGt: selection.GreaterThan, corev1.NodeSelectorOpLt: selection.LessThan,
	}
	op, ok := operators[expr.Operator]
	if !ok {
		return false
	}
	requirement, err := labels.NewRequirement(expr.Key, op, expr.Values)
	return err == nil && requirement.Matches(labels.Set(values))
}
