package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/client-go/metadata"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/workloads"
)

// Workloads enables the live workload tools.
type Workloads struct {
	Cache    *workloads.Cache
	Metadata metadata.Interface
	Judge    authz.Judge
	// Nil leaves restart_workload and terminate_pod unregistered.
	Actions *workloads.Actions
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
		Name:  "get_workloads",
		Title: "Get live workloads",
		Description: "Start here for questions about applications, workloads, what runs in a namespace, or which resources belong together. Specify namespace when known; omit it only for a cross-namespace overview of namespaces visible to the caller. " +
			"Returns current root owners with pods, images, ConfigMaps, Secrets, PVCs, Services, Ingresses and Certificates; shared dependencies may appear under several roots. Includes scaled-to-zero built-in controllers. " +
			"Built-in controller ancestry is resolved recursively; custom roots are terminal owner references marked ownerReferenceOnly unless a fixed adapter verifies them. " +
			"When the CNPG API is available and the caller can list Clusters, a fixed adapter associates explicit TLS Secret and monitoring query references; it does not verify health or traverse further custom ancestry. " +
			"Certificates join consumers through pod Secret references or associated Ingress TLS. Namespace/orphaned-workloads holds unclaimed resources; its orphaned mapping groups auxiliary generating owners by Kind.api-group and name. " +
			"Unused kube-root-ca.crt ConfigMaps, reflected copies, trust-manager bundles and Helm release records are excluded from orphan buckets; consumed copies remain workload dependencies. Orphaned does not mean safe to delete. " +
			"Namespace orphan buckets also include standalonePods name/UID pairs for ownerless, non-static pods. Empty lists and empty orphan buckets are omitted. " +
			"Read workloads in structuredContent; the text content is only a count and warning summary. Requires authenticated list pods permission; each collection is additionally filtered by caller list permission. " +
			"Warnings identify incomplete inventory: missing objects or dependencies must not be treated as confirmed absent. Secret and ConfigMap contents are never returned. " +
			"Watch-backed cached snapshot with opaque revision; no resource-usage or historical analysis.",
		InputSchema: inputSchema[namespaceInput](func(props map[string]*jsonschema.Schema) {
			namespaceProperty(props["namespace"])
		}),
		OutputSchema: schemaFor[*workloads.Inventory](),
		Annotations:  readOnly("Get live workloads"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in namespaceInput) (*mcp.CallToolResult, *workloads.Inventory, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, fmt.Errorf("workload listing requires an authenticated caller: %w", err)
		}
		inv, err := w.Cache.List(ctx, in.Namespace, id)
		if err != nil {
			return nil, nil, err
		}
		buckets := 0
		for _, wl := range inv.Workloads {
			if wl.Kind == "Namespace" {
				buckets++
			}
		}
		summary := fmt.Sprintf("%d workloads; %d namespace orphan buckets.", len(inv.Workloads)-buckets, buckets)
		if len(inv.Warnings) > 0 {
			summary += " " + strings.Join(inv.Warnings, " ")
		}

		return text(summary), inv, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_pods",
		Title: "List pod names",
		Description: "Use when only current pod names in a known namespace are needed, such as choosing a pod for logs or resource usage. For application inventory, owner relationships and dependencies, prefer get_workloads when available. " +
			"Requires authenticated list pods permission and reads metadata only. Returns sorted names; no pod status, containers or ownership. " +
			"Deleted pods are absent; a known deleted pod name may still have resource usage history. An incomplete listing is an error.",
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
	mutating := &mcp.ToolAnnotations{DestructiveHint: boolPtr(true), OpenWorldHint: boolPtr(false)}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "restart_workload",
		Title: "Restart a workload",
		Description: "Mutating operation, available only when MCP_WORKLOAD_RESTART_ENABLED is true. Use only when the user requests a restart. Obtain namespace, name, UID, kind and apiVersion from current get_workloads inventory; never infer UID. " +
			"Supports apps/v1 Deployment, StatefulSet and DaemonSet rollout restart, and postgresql.cnpg.io/v1 Cluster through its restart annotation. " +
			"Supports Redpanda cluster.redpanda.com/v1alpha1 or v1alpha2 via clusterSpec.statefulset.podTemplate.annotations, and Dragonfly dragonflydb.io/v1alpha1 via spec.annotations; verifies the installed operator schema before patching. " +
			"Operators manage pod recreation. Jobs, CronJobs, ReplicaSets and unknown operators are unsupported. Paused, OnDelete and partitioned rollouts are rejected. " +
			"Executes as the verified Kubernetes caller: requires get and patch on the exact target, and admission still applies. UID/resourceVersion guard against stale inventory and concurrent changes. " +
			"Returns request acceptance, not completed rollout or verified health. Can interrupt service; do not automatically retry an uncertain outcome.",
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
		Name:  "terminate_pod",
		Title: "Terminate a standalone pod",
		Description: "Mutating operation, available only when MCP_WORKLOAD_RESTART_ENABLED is true. Use only when the user explicitly requests termination of a standalone pod. Obtain name and UID from the namespace orphan bucket standalonePods in get_workloads. " +
			"Requires get and delete pods as the verified caller. Rechecks live ownerReferences and rejects owned pods (including Job/CronJob pods) and static mirror pods. " +
			"Deletes with UID/resourceVersion preconditions and the normal grace period; never force deletes. A standalone pod has no controller to recreate it. " +
			"Returns termination acceptance, not completed deletion. Do not automatically retry an uncertain outcome.",
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
}
