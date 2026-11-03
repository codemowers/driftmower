package provisioning

import (
	"fmt"
	"slices"
	"strings"
)

// OperatorHealth describes an offering's controller Deployment.
type OperatorHealth struct {
	// Prefix-matched, because Helm prepends the release name.
	Deployment        string
	Namespace         string
	ReadyReplicas     int32
	DesiredReplicas   int32
	Version           *string
	WatchedNamespaces WatchedNamespaces
}

// AvailabilityOf turns "is the CRD served" plus "is the controller running"
// into one of four states.
func AvailabilityOf(servesKind bool, operator *OperatorHealth, installHref *string) Availability {
	switch {
	case !servesKind:
		// Nothing understands the kind; an apply fails outright, which is at
		// least a loud failure.
		return Availability{State: StateNotInstalled, InstallHref: installHref}
	case operator == nil:
		// The quiet one: the apply succeeds and the object sits untouched.
		return Availability{State: StateCRDsOnly, Reason: "The custom resources exist but no controller is running. `kubectl apply` would succeed " +
			"and the object would sit there with nothing acting on it."}
	case operator.ReadyReplicas < 1:
		return Availability{State: StateDegraded, Version: operator.Version, Reason: fmt.Sprintf(
			"The controller Deployment %s/%s reports %d/%d pods ready. Manifests would apply but nothing would act on them.",
			operator.Namespace, operator.Deployment, operator.ReadyReplicas, operator.DesiredReplicas)}
	default:
		return Availability{State: StateReady, Version: operator.Version, WatchedNamespaces: operator.WatchedNamespaces}
	}
}

func IsOfferable(a Availability) bool {
	return a.State == StateReady || a.State == StateDegraded
}

// PodSecurityFact is Pod Security Admission's level for a namespace. It is a
// built-in controller, so it appears in no ValidatingAdmissionPolicy listing.
type PodSecurityFact struct {
	Enforce string `json:"enforce"`
	// What a pod must set to be admitted, in the API's own field names.
	Requires []string `json:"requires"`
	Summary  string   `json:"summary"`
}

// Quoted from the API server's denial in an enforce=restricted namespace.
var restrictedRequirements = []string{
	"securityContext.runAsNonRoot=true",
	"securityContext.allowPrivilegeEscalation=false",
	`securityContext.capabilities.drop=["ALL"]`,
	`securityContext.seccompProfile.type="RuntimeDefault"`,
}

func PodSecurityFor(labels map[string]string) *PodSecurityFact {
	switch strings.TrimSpace(labels["pod-security.kubernetes.io/enforce"]) {
	case "privileged":
		return &PodSecurityFact{Enforce: "privileged", Requires: []string{}, Summary: "No pod security level is enforced in this namespace."}
	case "baseline":
		return &PodSecurityFact{Enforce: "baseline", Requires: []string{},
			Summary: "Privileged containers, host networking and host paths are rejected, but running as root is allowed."}
	case "restricted":
		return &PodSecurityFact{Enforce: "restricted", Requires: slices.Clone(restrictedRequirements),
			Summary: "Containers cannot run as root here, and a pod that sets no securityContext at all is rejected outright — " +
				"the four fields below are required, not defaults."}
	}

	return nil
}

// Node is the part of a Node the topology fact reads.
type Node struct {
	Labels        map[string]string
	Unschedulable bool
	TaintEffects  []string
	Ready         bool
	Allocatable   map[string]string
}

const (
	zoneLabel = "topology.kubernetes.io/zone"
	unzoned   = "(no zone label)"
)

// Ordered by specificity: a node carrying both reports the explicit one.
var controlPlaneLabels = []struct{ key, value string }{
	{"codemowers.cloud/node-role", "control-plane"},
	{"node-role.kubernetes.io/control-plane", ""},
	{"node-role.kubernetes.io/master", ""},
}

// IsSchedulable excludes nodes that cannot take a new pod: cordoned, not
// ready, or tainted NoSchedule/NoExecute.
func IsSchedulable(n Node) bool {
	if n.Unschedulable || !n.Ready {
		return false
	}

	return !slices.ContainsFunc(n.TaintEffects, func(e string) bool { return e == "NoSchedule" || e == "NoExecute" })
}

func detectControlPlaneLabel(nodes []Node) *Label {
	for _, c := range controlPlaneLabels {
		for _, n := range nodes {
			actual, ok := n.Labels[c.key]
			if !ok || (c.value != "" && actual != c.value) {
				continue
			}
			value := c.value
			if value == "" {
				value = actual
			}

			return &Label{Key: c.key, Value: value}
		}
	}

	return nil
}

func ToTopologyFact(nodes []Node) TopologyFact {
	byZone := map[string]*ZoneFact{}
	var order []string
	schedulable := 0
	for _, n := range nodes {
		if !IsSchedulable(n) {
			continue
		}
		schedulable++
		zone, ok := n.Labels[zoneLabel]
		if !ok {
			zone = unzoned
		}
		cpu, _ := ParseCPUMillis(n.Allocatable["cpu"])
		memory, _ := ParseQuantity(n.Allocatable["memory"])
		z := byZone[zone]
		if z == nil {
			z = &ZoneFact{Zone: zone}
			byZone[zone] = z
			order = append(order, zone)
		}
		z.Nodes++
		z.Allocatable.CPUMillis += cpu
		z.Allocatable.MemoryBytes += memory
	}

	zones := make([]ZoneFact, 0, len(order))
	for _, name := range order {
		zones = append(zones, *byZone[name])
	}
	slices.SortStableFunc(zones, func(a, b ZoneFact) int { return localeCompare(a.Zone, b.Zone) })

	return TopologyFact{Zones: zones, SchedulableNodes: schedulable, ControlPlaneLabel: detectControlPlaneLabel(nodes)}
}

// DistinctZones counts zones a spread constraint could use; an unzoned
// cluster reports 0, so "spread across zones" is honestly decoration there.
func DistinctZones(t TopologyFact) int {
	n := 0
	for _, z := range t.Zones {
		if z.Zone != unzoned {
			n++
		}
	}

	return n
}
