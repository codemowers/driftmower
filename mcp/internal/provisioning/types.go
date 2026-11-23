// Package provisioning answers what can be provisioned where on this cluster:
// offerings, storage, topology, admission policies, ingress rules and
// per-namespace readiness, from live cluster facts and the caller's access.
//
// The wire types here are what GET /api/provisioning/capabilities returns and
// driftmower-ui relays, so their JSON shape is a contract: fields typed as
// pointers without omitempty are always present and may be null.
package provisioning

import (
	"encoding/json"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type OfferingID string

const (
	Postgres      OfferingID = "postgres"
	Dragonfly     OfferingID = "dragonfly"
	MongoDB       OfferingID = "mongodb"
	RabbitMQ      OfferingID = "rabbitmq"
	Redpanda      OfferingID = "redpanda"
	OpenSearch    OfferingID = "opensearch"
	Elasticsearch OfferingID = "elasticsearch"
	EMQX          OfferingID = "emqx"
	Bucket        OfferingID = "bucket"
)

// Purpose is what an offering is for, in the user's words rather than the
// operator's.
type Purpose string

type PresetID string

type Verdict = authz.Verdict

type DegradedRead struct {
	// The fact family, e.g. "storageclasses". A stable key for consumers.
	Source  string `json:"source"`
	Status  int    `json:"status"`
	Message string `json:"message"`
}

type WatchedNamespaces struct {
	All   bool
	Names []string
}

func (w WatchedNamespaces) MarshalJSON() ([]byte, error) {
	if w.All {
		return []byte(`"all"`), nil
	}
	if w.Names == nil {
		return []byte(`[]`), nil
	}

	return json.Marshal(w.Names)
}

func (w *WatchedNamespaces) UnmarshalJSON(b []byte) error {
	if string(b) == `"all"` {
		*w = WatchedNamespaces{All: true}

		return nil
	}

	return json.Unmarshal(b, &w.Names)
}

// Availability is one of four states that actually happen, including the two
// silent ones where an apply succeeds and nothing acts on the object.
type Availability struct {
	// ready, degraded, crds-only or not-installed.
	State             string
	Version           *string
	WatchedNamespaces WatchedNamespaces
	Reason            string
	InstallHref       *string
}

const (
	StateReady        = "ready"
	StateDegraded     = "degraded"
	StateCRDsOnly     = "crds-only"
	StateNotInstalled = "not-installed"
)

func (a Availability) MarshalJSON() ([]byte, error) {
	switch a.State {
	case StateReady:
		return json.Marshal(struct {
			State             string            `json:"state"`
			Version           *string           `json:"version"`
			WatchedNamespaces WatchedNamespaces `json:"watchedNamespaces"`
		}{a.State, a.Version, a.WatchedNamespaces})
	case StateDegraded:
		return json.Marshal(struct {
			State   string  `json:"state"`
			Version *string `json:"version"`
			Reason  string  `json:"reason"`
		}{a.State, a.Version, a.Reason})
	case StateCRDsOnly:
		return json.Marshal(struct {
			State  string `json:"state"`
			Reason string `json:"reason"`
		}{a.State, a.Reason})
	default:
		return json.Marshal(struct {
			State       string  `json:"state"`
			InstallHref *string `json:"installHref"`
		}{StateNotInstalled, a.InstallHref})
	}
}

func (a *Availability) UnmarshalJSON(b []byte) error {
	var raw struct {
		State             string            `json:"state"`
		Version           *string           `json:"version"`
		WatchedNamespaces WatchedNamespaces `json:"watchedNamespaces"`
		Reason            string            `json:"reason"`
		InstallHref       *string           `json:"installHref"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*a = Availability(raw)

	return nil
}

type Preset struct {
	ID      PresetID `json:"id"`
	Label   string   `json:"label"`
	Summary string   `json:"summary"`
}

type OperatorInfo struct {
	Name     string `json:"name"`
	Vendor   string `json:"vendor"`
	DocsHref string `json:"docsHref"`
}

type OfferingCard struct {
	ID      OfferingID `json:"id"`
	Name    string     `json:"name"`
	Purpose Purpose    `json:"purpose"`
	// One plain-words sentence; never mentions the operator.
	What     string        `json:"what"`
	GoodFor  []string      `json:"goodFor"`
	Operator *OperatorInfo `json:"operator"`
	// "clusters.postgresql.cnpg.io": the resource a user would kubectl get.
	Resource *string `json:"resource"`
	// The version negotiated against this cluster, not the recipe's preference.
	APIVersion   *string      `json:"apiVersion"`
	Availability Availability `json:"availability"`
	Presets      []Preset     `json:"presets"`
	// What the offering would need before it could be installed here.
	Needs []string `json:"needs"`
	// Bound MutatingAdmissionPolicies that rewrite the offering's resources on
	// create, each with its author's description.
	AdmissionDefaults []AdmissionDefault `json:"admissionDefaults"`
	// Present only when a namespace was asked about.
	MayCreate       *Verdict `json:"mayCreate,omitempty"`
	MayCreateReason string   `json:"mayCreateReason,omitempty"`
}

// StorageTopology is how a volume behaves: the difference between
// "3 replicas" meaning resilience and meaning three copies pinned to three
// machines.
type StorageTopology string

const (
	NodeLocal       StorageTopology = "node-local"
	Zonal           StorageTopology = "zonal"
	ClusterWide     StorageTopology = "cluster-wide"
	UnknownTopology StorageTopology = "unknown"
)

type StorageClassFact struct {
	Name           string          `json:"name"`
	Provisioner    string          `json:"provisioner"`
	IsDefault      bool            `json:"isDefault"`
	BindingMode    string          `json:"bindingMode"`
	AllowExpansion bool            `json:"allowExpansion"`
	ReclaimPolicy  string          `json:"reclaimPolicy"`
	Topology       StorageTopology `json:"topology"`
	// Exactly one beginner-facing clause.
	Implies string `json:"implies"`
	// Can two instances live here and still be moved by their operator?
	ReplicaSafe bool `json:"replicaSafe"`
	// The class's kubernetes.io/description, Markdown.
	Description *string `json:"description,omitempty"`
}

type QuotaAmounts map[string]string

type NetworkPosture string

const (
	DefaultDeny    NetworkPosture = "default-deny"
	Open           NetworkPosture = "open"
	UnknownPosture NetworkPosture = "unknown"
)

type Verb string

var Verbs = []Verb{"get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"}

type ProvisionRow struct {
	Resource string  `json:"resource"`
	Verdict  Verdict `json:"verdict"`
	Reason   *string `json:"reason"`
}

type AccessSummary struct {
	ResourceTypes int          `json:"resourceTypes"`
	ByVerb        map[Verb]int `json:"byVerb"`
	Unknown       int          `json:"unknown"`
}

type AccessProfile struct {
	// "group/resource" (core group is "") -> verdict per verb.
	Matrix          map[string]map[Verb]Verdict   `json:"matrix,omitempty"`
	View            Verdict                       `json:"view"`
	Edit            Verdict                       `json:"edit"`
	Admin           Verdict                       `json:"admin"`
	Provision       map[OfferingID]Verdict        `json:"provision"`
	ProvisionDetail map[OfferingID][]ProvisionRow `json:"provisionDetail"`
	Summary         AccessSummary                 `json:"summary"`
}

type Tenant struct {
	LabelKey string `json:"labelKey"`
	ID       string `json:"id"`
}

type Quota struct {
	Name string       `json:"name"`
	Used QuotaAmounts `json:"used"`
	Hard QuotaAmounts `json:"hard"`
}

// Headroom is quota hard minus used per dimension; nil is unlimited.
type Headroom struct {
	CPUMillis    *int64   `json:"cpuMillis"`
	MemoryBytes  *float64 `json:"memoryBytes"`
	StorageBytes *float64 `json:"storageBytes"`
	PVCCount     *int64   `json:"pvcCount"`
	Pods         *int64   `json:"pods"`
}

type LimitRangeDefaults struct {
	DefaultRequest QuotaAmounts `json:"defaultRequest"`
	Default        QuotaAmounts `json:"default"`
}

type NetworkFact struct {
	Ingress NetworkPosture `json:"ingress"`
	Egress  NetworkPosture `json:"egress"`
	// Every policy that selects on an offering's own label, with the selector
	// shape preserved.
	Selectors       []PolicySelector `json:"selectors"`
	CiliumAvailable bool             `json:"ciliumAvailable"`
}

type VerdictReason struct {
	Verdict Verdict `json:"verdict"`
	Reason  string  `json:"reason"`
}

type NamespaceFact struct {
	Namespace string `json:"namespace"`
	// The namespace label an enforced admission guard scopes on, and its value
	// here. Discovered from the cluster's own policies, never configured.
	Tenant *Tenant `json:"tenant"`
	// Kept for consumers that still read it; equals tenant.id.
	Sandbox    *string             `json:"sandbox"`
	Quota      *Quota              `json:"quota"`
	Headroom   *Headroom           `json:"headroom"`
	LimitRange *LimitRangeDefaults `json:"limitRange"`
	Network    NetworkFact         `json:"network"`
	// One SubjectAccessReview per resource and verb, as the verified caller.
	// Nil when the call was unauthenticated.
	Access *AccessProfile `json:"access"`
	// For the offering asked about; admission denials first, then RBAC.
	MayCreate       Verdict `json:"mayCreate"`
	MayCreateReason string  `json:"mayCreateReason"`
	// The same verdict for every offering in the catalog, with enforced
	// admission policies applied.
	Offerings map[OfferingID]VerdictReason `json:"offerings"`
	// Registries published from this namespace.
	Registries  []RegistryFact   `json:"registries"`
	PodSecurity *PodSecurityFact `json:"podSecurity"`
}

type PolicySelector struct {
	Policy    string `json:"policy"`
	Kind      string `json:"kind"`
	Direction string `json:"direction"`
	LabelKey  string `json:"labelKey"`
	// Nil when the selector is Exists, i.e. it matches every instance name.
	LabelValue *string `json:"labelValue"`
	Admits     string  `json:"admits"`
}

type Allocatable struct {
	CPUMillis   int64   `json:"cpuMillis"`
	MemoryBytes float64 `json:"memoryBytes"`
}

type ZoneFact struct {
	Zone        string      `json:"zone"`
	Nodes       int         `json:"nodes"`
	Allocatable Allocatable `json:"allocatable"`
}

type Label struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type TopologyFact struct {
	Zones            []ZoneFact `json:"zones"`
	SchedulableNodes int        `json:"schedulableNodes"`
	// Derived from node labels rather than configured per cluster.
	ControlPlaneLabel *Label `json:"controlPlaneLabel"`
}

type PolicyFact struct {
	Engine string `json:"engine"`
	Name   string `json:"name"`
	// Enforce policies can reject an apply; Audit ones only report.
	Mode    string   `json:"mode"`
	Touches []string `json:"touches"`
	Meaning string   `json:"meaning"`
}

type HostRule struct {
	Namespace string  `json:"namespace"`
	TenantID  *string `json:"tenantId"`
	// Equals tenantId.
	SandboxID       *string `json:"sandboxId"`
	ExactHost       *string `json:"exactHost"`
	LabelledPattern *string `json:"labelledPattern"`
	EnforcedBy      *string `json:"enforcedBy"`
	// The guard's own denial text.
	EnforcedMessage *string  `json:"enforcedMessage"`
	CustomDomains   []string `json:"customDomains"`
	Note            string   `json:"note"`
}

type IngressClassFact struct {
	Name       string `json:"name"`
	Controller string `json:"controller"`
	IsDefault  bool   `json:"isDefault"`
}

type IngressFact struct {
	DomainSuffix *string `json:"domainSuffix"`
	// "guard-params" is what admission compares against; "config" was set by
	// the operator of this server and is not verified against any policy.
	DomainSuffixSource *string            `json:"domainSuffixSource"`
	Classes            []IngressClassFact `json:"classes"`
	ClusterIssuers     []string           `json:"clusterIssuers"`
	TLSAdvice          string             `json:"tlsAdvice"`
	HostRules          []HostRule         `json:"hostRules"`
}

// AdmissionFact is the client's projection of a ValidatingAdmissionPolicy.
type AdmissionFact struct {
	Name                    string             `json:"name"`
	Enforced                bool               `json:"enforced"`
	Enforcement             string             `json:"enforcement"`
	Guards                  []GuardedOperation `json:"guards"`
	Messages                []string           `json:"messages"`
	Description             *string            `json:"description"`
	ScopedToNamespaceLabels map[string]string  `json:"scopedToNamespaceLabels"`
}

type PriorityClassFact struct {
	Name      string `json:"name"`
	Value     int32  `json:"value"`
	IsDefault bool   `json:"isDefault"`
	Meaning   string `json:"meaning"`
}

type CapabilityResponse struct {
	InCluster           bool                `json:"inCluster"`
	Offerings           []OfferingCard      `json:"offerings"`
	StorageClasses      []StorageClassFact  `json:"storageClasses"`
	Topology            TopologyFact        `json:"topology"`
	Namespaces          []NamespaceFact     `json:"namespaces"`
	Policies            []PolicyFact        `json:"policies"`
	AdmissionPolicies   []AdmissionFact     `json:"admissionPolicies"`
	Ingress             IngressFact         `json:"ingress"`
	PriorityClasses     []PriorityClassFact `json:"priorityClasses"`
	NetworkPolicyEngine string              `json:"networkPolicyEngine"`
	MonitoringOperator  bool                `json:"monitoringOperator"`
	Degraded            []DegradedRead      `json:"degraded"`
}

// localeLess orders strings case-insensitively first, approximating
// JavaScript's localeCompare closely enough for display order.
func localeLess(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		return la < lb
	}

	return a < b
}

func localeCompare(a, b string) int {
	switch {
	case a == b:
		return 0
	case localeLess(a, b):
		return -1
	default:
		return 1
	}
}

var whitespace = strings.Fields

// foldSpace collapses runs of whitespace and trims, like
// `s.replace(/\s+/g, ' ').trim()`.
func foldSpace(s string) string {
	return strings.Join(whitespace(s), " ")
}

// unique keeps the first occurrence of each item, in order.
func unique[T comparable](items []T) []T {
	seen := make(map[T]bool, len(items))
	out := make([]T, 0, len(items))
	for _, item := range items {
		if !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}

	return out
}
