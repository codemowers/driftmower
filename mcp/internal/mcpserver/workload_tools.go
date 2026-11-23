package mcpserver

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/client-go/metadata"

	"github.com/codemowers/driftmower/internal/registry"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

type Workloads struct {
	MissingComponents []string
	Registry          *registry.Reader
	ScanURL           string
	ScanTokenFile     string
	Cache             *workloads.Cache
	Metadata          metadata.Interface
	Judge             authz.Judge
	// Argo CD's public address; empty leaves application links out.
	ArgoCDURL string
	// Nil leaves restart_workload and terminate_pod unregistered.
	Actions *workloads.Actions
}

type workloadInput struct {
	namespaceInput
	IncludeSources  bool `json:"includeSources,omitempty" jsonschema:"Resolve source-repository references for these workloads; excludes layers and crawler results"`
	IncludeFinished bool `json:"includeFinished,omitempty" jsonschema:"Also list Succeeded and Failed Pods"`
	IncludeOrphans  bool `json:"includeOrphans,omitempty" jsonschema:"Also list each namespace's unclaimed resources"`
}

type namespaceInput struct {
	Namespace string `json:"namespace,omitempty"`
}

type podsInput struct {
	Namespace string `json:"namespace"`
}

type podsOutput struct {
	Namespace string   `json:"namespace"`
	Pods      []string `json:"pods"`
}

type restartInput struct {
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
}

type expandInput struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	UID       string `json:"uid"`
	Storage   string `json:"storage"`
}

type terminateInput struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	UID       string `json:"uid"`
}

func targetProperties(props map[string]*jsonschema.Schema) {
	namespaceProperty(props["namespace"])
	props["name"].MaxLength, props["name"].Pattern = jsonschema.Ptr(253), `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`
	props["uid"].MinLength, props["uid"].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(253)
}

func addWorkloadTools(s *mcp.Server, w *Workloads, m auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "get_workloads",
		Title:       "Get live workloads",
		Description: "Start here for applications and what runs in a namespace. A tree of root owners with their running Pods, images, ConfigMaps, Secrets, PVCs, Services, Ingresses and Certificates; a standalone Pod is its own owner. Pod facts every Pod of an owner shares are on the owner. includeFinished adds finished Pods, includeOrphans each namespace's unclaimed resources (orphaned does not mean safe to delete), includeSources source repositories.",
		InputSchema: inputSchema[workloadInput](func(props map[string]*jsonschema.Schema) {
			namespaceProperty(props["namespace"])
		}),
		OutputSchema: schemaFor[*inventoryTree](),
		Annotations:  readOnly("Get live workloads"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in workloadInput) (*mcp.CallToolResult, *inventoryTree, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("workload listing requires an authenticated caller: %w", err)
		}
		inv, err := w.Cache.List(ctx, in.Namespace, id)
		if err != nil {
			return nil, nil, err
		}
		copyInv := *inv
		inv = &copyInv
		if in.IncludeSources {
			var warnings []string
			inv.Workloads, warnings, err = workloadSources(ctx, w, id, inv.Workloads)
			if err != nil {
				return nil, nil, err
			}
			inv.Warnings = append(inv.Warnings, warnings...)
		}
		pods, podWarnings, err := w.Cache.Pods(ctx, in.Namespace, id)
		if err != nil {
			return nil, nil, err
		}
		inv.Warnings = append(slices.Clone(inv.Warnings), podWarnings...)
		tree := buildInventoryTree(inv, pods, in.IncludeFinished, in.IncludeOrphans)
		summary := fmt.Sprintf("%d owners.", len(tree.Owners))
		if len(tree.Warnings) > 0 {
			summary += " " + strings.Join(tree.Warnings, " ")
		}
		return text(summary), tree, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_pods",
		Title:       "List pod names",
		Description: "Pod names in a namespace.",
		InputSchema: inputSchema[podsInput](func(props map[string]*jsonschema.Schema) {
			namespaceProperty(props["namespace"])
		}),
		Annotations: readOnly("List pod names"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in podsInput) (*mcp.CallToolResult, podsOutput, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, podsOutput{}, fmt.Errorf("pod listing requires an authenticated caller: %w", err)
		}
		names, err := workloads.ListPodNames(ctx, w.Metadata, w.Judge, id, in.Namespace)
		if err != nil {
			return nil, podsOutput{}, err
		}
		if names == nil {
			names = []string{}
		}

		return nil, podsOutput{Namespace: in.Namespace, Pods: names}, nil
	})

	if w.Actions == nil {
		return
	}
	mutating := &mcp.ToolAnnotations{DestructiveHint: new(true), OpenWorldHint: new(false)}

	mcp.AddTool(s, &mcp.Tool{
		Name:        "restart_workload",
		Title:       "Restart a workload",
		Description: "Rollout-restart a Deployment, StatefulSet, DaemonSet, CNPG Cluster, Redpanda or Dragonfly. Take UID and resourceVersion from get_workloads. Only on explicit user request; do not retry an uncertain result.",
		InputSchema: strict(inputSchema[restartInput](func(props map[string]*jsonschema.Schema) {
			targetProperties(props)
			props["apiVersion"].Enum = []any{"apps/v1", "postgresql.cnpg.io/v1", "cluster.redpanda.com/v1alpha1", "cluster.redpanda.com/v1alpha2", "dragonflydb.io/v1alpha1"}
			props["kind"].Enum = []any{"Deployment", "StatefulSet", "DaemonSet", "Cluster", "Redpanda", "Dragonfly"}
		})),
		Annotations: mutating,
	}, func(ctx context.Context, req *mcp.CallToolRequest, in restartInput) (*mcp.CallToolResult, *workloads.ActionResult, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("restart requires an authenticated caller: %w", err)
		}
		result, err := w.Actions.Restart(ctx, workloads.RestartInput{
			Target: workloads.Target{Namespace: in.Namespace, Name: in.Name, UID: in.UID}, APIVersion: in.APIVersion, Kind: in.Kind,
		}, id)
		if err != nil {
			return nil, nil, err
		}

		return text(result.Message), result, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "terminate_pod",
		Title:       "Delete a Pod",
		Description: "Delete one Pod by its UID using the caller’s Kubernetes permissions and normal grace period. Its controller may create a replacement when applicable; standalone Pods are not recreated automatically. Static mirror Pods are rejected. Only on explicit user request; do not retry an uncertain result.",
		InputSchema: strict(inputSchema[terminateInput](targetProperties)),
		Annotations: mutating,
	}, func(ctx context.Context, req *mcp.CallToolRequest, in terminateInput) (*mcp.CallToolResult, *workloads.ActionResult, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("termination requires an authenticated caller: %w", err)
		}
		result, err := w.Actions.Terminate(ctx, workloads.Target{Namespace: in.Namespace, Name: in.Name, UID: in.UID}, id)
		if err != nil {
			return nil, nil, err
		}

		return text(result.Message), result, nil
	})
	mcp.AddTool(s, &mcp.Tool{
		Name:        "expand_volume",
		Title:       "Expand a PersistentVolumeClaim",
		Description: "Set a PVC's storage request to an absolute size, at most double the current one; smaller sizes are no-ops. Take UID from list_volumes (canExpand). Volumes cannot shrink. Only on explicit user request.",
		InputSchema: strict(inputSchema[expandInput](func(props map[string]*jsonschema.Schema) {
			targetProperties(props)
			props["storage"].MinLength, props["storage"].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(64)
			props["storage"].Pattern = `^[0-9]+(\.[0-9]+)?([KMGTPE]i?|[eE][0-9]+|k)?$`
		})),
		Annotations: mutating,
	}, func(ctx context.Context, req *mcp.CallToolRequest, in expandInput) (*mcp.CallToolResult, *workloads.ExpandResult, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("volume expansion requires an authenticated caller: %w", err)
		}
		result, err := w.Actions.Expand(ctx, workloads.ExpandInput{Target: workloads.Target{Namespace: in.Namespace, Name: in.Name, UID: in.UID}, Storage: in.Storage}, id)
		if err != nil {
			return nil, nil, err
		}

		return text(result.Message), result, nil
	})
}
