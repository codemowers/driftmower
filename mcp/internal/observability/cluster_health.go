package observability

import (
	"context"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type NodePressure struct {
	Memory bool `json:"memory"`
	Disk   bool `json:"disk"`
	PID    bool `json:"pid"`
}

// Used and total bytes of one node capacity, with its source and graph.
type NodeStorage struct {
	Used   float64 `json:"used"`
	Total  float64 `json:"total"`
	Source string  `json:"source"`
	// PromQL for a graph of used and total on this node.
	Graph []string `json:"graph"`
}

type ClusterNode struct {
	Name              string       `json:"name"`
	Roles             []string     `json:"roles"`
	Readiness         string       `json:"readiness"`
	Conditions        []string     `json:"conditions"`
	Schedulable       bool         `json:"schedulable"`
	Pressure          NodePressure `json:"pressure"`
	KubeletVersion    string       `json:"kubeletVersion"`
	OSImage           string       `json:"osImage"`
	KernelVersion     string       `json:"kernelVersion"`
	ContainerRuntime  string       `json:"containerRuntime"`
	Architecture      string       `json:"architecture"`
	CreationTimestamp string       `json:"creationTimestamp"`
	BootTimeSeconds   *float64     `json:"bootTimeSeconds"`
	// From Prometheus; nil when unavailable. LVM is the TopoLVM volume
	// group's allocation, for PersistentVolumes; Ephemeral is the root
	// filesystem, holding images, logs and emptyDirs.
	Memory    *NodeStorage `json:"memory"`
	LVM       *NodeStorage `json:"lvm"`
	Ephemeral *NodeStorage `json:"ephemeral"`
}

type ByteUsage struct {
	Used  float64 `json:"used"`
	Total float64 `json:"total"`
}

type MemoryUsage struct {
	Total   float64 `json:"total"`
	Used    float64 `json:"used"`
	Buffers float64 `json:"buffers"`
	Cached  float64 `json:"cached"`
}

type CPUUsage struct {
	Used     float64 `json:"used"`
	Capacity float64 `json:"capacity"`
}

type NodeIO struct {
	Node      string   `json:"node"`
	NetworkRx *float64 `json:"networkRx"`
	NetworkTx *float64 `json:"networkTx"`
	DiskRead  *float64 `json:"diskRead"`
	DiskWrite *float64 `json:"diskWrite"`
}

type ClusterIO struct {
	NetworkRx *float64 `json:"networkRx"`
	NetworkTx *float64 `json:"networkTx"`
	DiskRead  *float64 `json:"diskRead"`
	DiskWrite *float64 `json:"diskWrite"`
	Nodes     []NodeIO `json:"nodes"`
	Warnings  []string `json:"warnings"`
}

// ClusterResources are cluster totals; each is nil when its metrics are
// unavailable.
type ClusterResources struct {
	Storage *ByteUsage   `json:"storage"`
	Memory  *MemoryUsage `json:"memory"`
	CPU     *CPUUsage    `json:"cpu"`
	IO      *ClusterIO   `json:"io"`
	// MinIO buckets across the cluster.
	Buckets *BucketAmounts `json:"buckets"`
	// PromQL for graphs of each cluster total and its capacity, by storage,
	// memory and cpu.
	Graphs map[string][]string `json:"graphs"`
}

type ClusterHealth struct {
	ObservedAt string            `json:"observedAt"`
	Nodes      []ClusterNode     `json:"nodes"`
	Resources  *ClusterResources `json:"resources"`
	Degraded   []VolumeDegraded  `json:"degraded"`
}

// ClusterHealth lists Nodes from the Kubernetes API and, when Prometheus is
// configured, enriches them with resource usage and per-node storage. It
// requires cluster-wide list nodes and list pods.
func (s *Service) ClusterHealth(ctx context.Context, id authz.Identity) (*ClusterHealth, error) {
	for _, resource := range []string{"nodes", "pods"} {
		if err := s.require(ctx, id, authz.Attributes{Resource: resource, Verb: "list"},
			"Kubernetes RBAC denied list "+resource+" cluster-wide"); err != nil {
			return nil, err
		}
	}
	list, err := s.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := &ClusterHealth{ObservedAt: s.now().UTC().Format("2006-01-02T15:04:05.000Z"), Nodes: describeNodes(list.Items), Degraded: []VolumeDegraded{}}
	if !s.MetricsEnabled() {
		out.Degraded = append(out.Degraded, VolumeDegraded{Source: "prometheus", Message: "Prometheus is not configured; nodes are listed without usage"})

		return out, nil
	}

	usage, err := s.ClusterUsage(ctx, id, ClusterUsageInput{WindowSeconds: 300, PerNode: true}, nil)
	if err != nil {
		out.Degraded = append(out.Degraded, VolumeDegraded{Source: "usage", Message: err.Error()})
	} else {
		out.Resources = clusterResources(usage)
		if err := func(backend Requester) error {
			buckets, err := s.clusterBuckets(ctx, backend)
			out.Resources.Buckets = buckets
			if buckets != nil {
				out.Resources.Graphs["buckets"] = []string{"sum(max by (bucket) (minio_bucket_usage_total_bytes))", "sum(max by (bucket) (minio_bucket_quota_total_bytes))"}
			}

			return err
		}(s.Backend); err != nil {
			out.Degraded = append(out.Degraded, VolumeDegraded{Source: "buckets", Message: err.Error()})
		}
		lvm := nodeStorage(usage, "lvmVolumeGroupAllocated", "lvmVolumeGroupSize", "topolvm")
		ephemeral := nodeStorage(usage, "rootFilesystemUsed", "rootFilesystemCapacity", "rootFilesystem")
		memory := nodeStorage(usage, "memoryUsed", "memoryCapacity", "nodeMemory")
		for i := range out.Nodes {
			if metric := usage.Metrics["bootTime"]; metric != nil {
				for _, sample := range metric.Breakdown {
					if sample.Labels["node"] == out.Nodes[i].Name && sample.Value > 0 && sample.Value <= float64(s.now().Unix()) {
						value := sample.Value
						out.Nodes[i].BootTimeSeconds = &value
					}
				}
			}
			out.Nodes[i].Memory = memory[out.Nodes[i].Name]
			out.Nodes[i].LVM, out.Nodes[i].Ephemeral = lvm[out.Nodes[i].Name], ephemeral[out.Nodes[i].Name]
		}
	}

	return out, nil
}

func describeNodes(items []corev1.Node) []ClusterNode {
	out := make([]ClusterNode, 0, len(items))
	for _, n := range items {
		condition := func(t corev1.NodeConditionType) corev1.ConditionStatus {
			for _, c := range n.Status.Conditions {
				if c.Type == t {
					return c.Status
				}
			}

			return corev1.ConditionUnknown
		}
		readiness := "Unknown"
		switch condition(corev1.NodeReady) {
		case corev1.ConditionTrue:
			readiness = "Ready"
		case corev1.ConditionFalse:
			readiness = "NotReady"
		}
		roles := []string{}
		for key := range n.Labels {
			if role, ok := strings.CutPrefix(key, "node-role.kubernetes.io/"); ok && role != "" {
				roles = append(roles, role)
			}
		}
		slices.Sort(roles)
		info := n.Status.NodeInfo
		conditions := []string{}
		for _, c := range n.Status.Conditions {
			if c.Type != corev1.NodeReady && c.Status == corev1.ConditionTrue {
				conditions = append(conditions, string(c.Type))
			}
		}
		slices.Sort(conditions)
		out = append(out, ClusterNode{
			Name: n.Name, Roles: roles, Readiness: readiness, Conditions: conditions, Schedulable: !n.Spec.Unschedulable,
			Pressure: NodePressure{
				Memory: condition(corev1.NodeMemoryPressure) == corev1.ConditionTrue,
				Disk:   condition(corev1.NodeDiskPressure) == corev1.ConditionTrue,
				PID:    condition(corev1.NodePIDPressure) == corev1.ConditionTrue,
			},
			KubeletVersion: info.KubeletVersion, OSImage: info.OSImage, KernelVersion: info.KernelVersion,
			ContainerRuntime: info.ContainerRuntimeVersion, Architecture: info.Architecture,
			CreationTimestamp: n.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	slices.SortFunc(out, func(a, b ClusterNode) int { return strings.Compare(a.Name, b.Name) })

	return out
}

func usageTotal(u *Usage, name string) *float64 {
	if q := u.Metrics[name]; q != nil {
		return q.Total
	}

	return nil
}

// clusterResources summarises cluster usage: TopoLVM allocation, memory
// used beside buffers and cache, and CPU used against capacity.
func clusterResources(u *Usage) *ClusterResources {
	out := &ClusterResources{Graphs: map[string][]string{}}
	graph := func(key string, names ...string) {
		for _, name := range names {
			if q := u.Metrics[name]; q != nil && q.Query != "" {
				out.Graphs[key] = append(out.Graphs[key], "sum("+q.Query+")")
			}
		}
	}
	graph("storage", "lvmVolumeGroupAllocated", "lvmVolumeGroupSize")
	graph("memory", "memoryUsed", "memoryCapacity")
	graph("cpu", "cpuUsed", "cpuCapacity")
	graph("network", "networkRx", "networkTx")
	graph("disk", "diskRead", "diskWrite")
	io := &ClusterIO{NetworkRx: usageTotal(u, "networkRx"), NetworkTx: usageTotal(u, "networkTx"), DiskRead: usageTotal(u, "diskRead"), DiskWrite: usageTotal(u, "diskWrite"), Nodes: []NodeIO{}, Warnings: []string{}}
	nodes := map[string]*NodeIO{}
	for _, name := range []string{"networkRx", "networkTx", "diskRead", "diskWrite"} {
		if q := u.Metrics[name]; q != nil {
			io.Warnings = append(io.Warnings, q.Warnings...)
			if q.Error != "" {
				io.Warnings = append(io.Warnings, name+": "+q.Error)
			}
			for _, sample := range q.Breakdown {
				node := sample.Labels["node"]
				if node == "" {
					continue
				}
				n := nodes[node]
				if n == nil {
					n = &NodeIO{Node: node}
					nodes[node] = n
				}
				v := sample.Value
				switch name {
				case "networkRx":
					n.NetworkRx = &v
				case "networkTx":
					n.NetworkTx = &v
				case "diskRead":
					n.DiskRead = &v
				case "diskWrite":
					n.DiskWrite = &v
				}
			}
		}
	}
	for _, n := range nodes {
		io.Nodes = append(io.Nodes, *n)
	}
	slices.SortFunc(io.Nodes, func(a, b NodeIO) int { return strings.Compare(a.Node, b.Node) })
	out.IO = io
	if size, allocated := usageTotal(u, "lvmVolumeGroupSize"), usageTotal(u, "lvmVolumeGroupAllocated"); size != nil && allocated != nil && *size > 0 {
		out.Storage = &ByteUsage{Used: *allocated, Total: *size}
	}
	if total, used := usageTotal(u, "memoryCapacity"), usageTotal(u, "memoryUsed"); total != nil && used != nil {
		value := func(name string) float64 {
			if v := usageTotal(u, name); v != nil {
				return *v
			}

			return 0
		}
		// MemAvailable already counts reclaimable cache, so the segments are
		// clamped to the space left beside used memory.
		free := max(0, *total-*used)
		buffers := min(value("memoryBuffers"), free)
		cached := min(value("memoryCached"), free-buffers)
		out.Memory = &MemoryUsage{Total: *total, Used: *used, Buffers: buffers, Cached: cached}
	}
	if used, capacity := usageTotal(u, "cpuUsed"), usageTotal(u, "cpuCapacity"); used != nil && capacity != nil {
		out.CPU = &CPUUsage{Used: *used, Capacity: *capacity}
	}

	return out
}

// nodeStorage is one kind of storage per node, summed across series such
// as TopoLVM's one per device class.
func nodeStorage(u *Usage, usedMetric, sizeMetric, source string) map[string]*NodeStorage {
	byNode := func(name string) map[string]float64 {
		out := map[string]float64{}
		if q := u.Metrics[name]; q != nil {
			for _, smp := range q.Breakdown {
				if node := smp.Labels["node"]; node != "" {
					out[node] += smp.Value
				}
			}
		}

		return out
	}
	out := map[string]*NodeStorage{}
	used := byNode(usedMetric)
	for node, size := range byNode(sizeMetric) {
		if v, ok := used[node]; ok && size > 0 {
			graph := []string{}
			for _, name := range []string{usedMetric, sizeMetric} {
				if q := u.Metrics[name]; q != nil && q.Query != "" {
					graph = append(graph, "("+q.Query+") and on (node) kube_node_info{node="+promString(node)+"}")
				}
			}
			out[node] = &NodeStorage{Used: v, Total: size, Source: source, Graph: graph}
		}
	}

	return out
}
