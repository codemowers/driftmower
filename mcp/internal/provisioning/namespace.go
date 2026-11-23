package provisioning

import (
	"fmt"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/nonnil"
)

// Namespace budget and network posture: the two things that decide whether a
// perfectly valid manifest will actually come up.

type NetworkPolicyInput struct {
	Name        string
	PodSelector *LabelSelector
	PolicyTypes []string
	// Nil when the field is absent, which matters for defaulting policyTypes.
	Ingress []any
	Egress  []any
	// Whether the egress field was present at all.
	HasEgress bool
}

type CiliumPolicyInput struct {
	Name             string
	EndpointSelector *LabelSelector
	IngressEntities  [][]string
	EgressEntities   [][]string
}

func selectsEverything(s *LabelSelector) bool {
	return s == nil || (len(s.MatchLabels) == 0 && len(s.MatchExpressions) == 0)
}

// effectiveTypes applies the API default: Ingress, plus Egress when the policy
// carries egress rules. Reading the field blindly misses default-deny
// policies.
func effectiveTypes(p NetworkPolicyInput) []string {
	if len(p.PolicyTypes) > 0 {
		return unique(p.PolicyTypes)
	}
	if p.HasEgress {
		return []string{"Ingress", "Egress"}
	}

	return []string{"Ingress"}
}

// DetectPosture finds a default deny: a policy selecting every pod that
// declares the direction and permits nothing in it.
func DetectPosture(policies []NetworkPolicyInput, direction string) NetworkPosture {
	for _, p := range policies {
		if !slices.Contains(effectiveTypes(p), direction) || !selectsEverything(p.PodSelector) {
			continue
		}
		rules := p.Ingress
		if direction == "Egress" {
			rules = p.Egress
		}
		if len(rules) == 0 {
			return DefaultDeny
		}
	}

	return Open
}

func valueFor(s *LabelSelector, key string) (present bool, value *string) {
	if s == nil {
		return false, nil
	}
	if v, ok := s.MatchLabels[key]; ok {
		return true, &v
	}
	for _, e := range s.MatchExpressions {
		if e.Key != key {
			continue
		}
		// Exists matches every value, so the policy covers any instance name.
		if e.Operator == "In" && len(e.Values) == 1 {
			return true, &e.Values[0]
		}
		// Exists, In with several values or NotIn: present but no single
		// value, so no coverage is claimed that cannot be proven.
		return true, nil
	}

	return false, nil
}

// ExtractSelectors finds the policies keyed on an offering's own label, and
// whether they name one instance or any.
func ExtractSelectors(labelKey string, native []NetworkPolicyInput, cilium []CiliumPolicyInput) []PolicySelector {
	found := []PolicySelector{}
	for _, p := range native {
		if p.Name == "" {
			continue
		}
		present, value := valueFor(p.PodSelector, labelKey)
		if !present {
			continue
		}
		for _, direction := range effectiveTypes(p) {
			rules := p.Ingress
			switch direction {
			case "Ingress":
			case "Egress":
				rules = p.Egress
			default:
				continue
			}
			if len(rules) == 0 {
				continue
			}
			found = append(found, PolicySelector{
				Policy: p.Name, Kind: "NetworkPolicy", Direction: direction, LabelKey: labelKey, LabelValue: value,
				Admits: fmt.Sprintf("%d %s rule(s) from pod or namespace selectors", len(rules), strings.ToLower(direction)),
			})
		}
	}
	for _, p := range cilium {
		if p.Name == "" {
			continue
		}
		present, value := valueFor(p.EndpointSelector, labelKey)
		if !present {
			continue
		}
		for _, entities := range p.IngressEntities {
			// Entity-based rules are the only way to admit node-sourced
			// traffic, which is what CNPG's health probes are.
			list := strings.Join(entities, ", ")
			if list == "" {
				list = "(none)"
			}
			found = append(found, PolicySelector{Policy: p.Name, Kind: "CiliumNetworkPolicy", Direction: "Ingress",
				LabelKey: labelKey, LabelValue: value, Admits: "ingress from entities " + list})
		}
		for _, entities := range p.EgressEntities {
			list := strings.Join(entities, ", ")
			if list == "" {
				list = "(services)"
			}
			found = append(found, PolicySelector{Policy: p.Name, Kind: "CiliumNetworkPolicy", Direction: "Egress",
				LabelKey: labelKey, LabelValue: value, Admits: "egress to entities " + list})
		}
	}

	return found
}

// ResourceQuotaInput carries a quota's amounts; Status is preferred because it
// carries what the API server enforces.
type ResourceQuotaInput struct {
	Name       string
	StatusHard QuotaAmounts
	StatusUsed QuotaAmounts
	SpecHard   QuotaAmounts
}

// ComputeHeadroom is hard minus used per dimension. A dimension the quota does
// not mention is unlimited: nil, not 0, so a planner never invents a cap.
func ComputeHeadroom(q *ResourceQuotaInput) *Headroom {
	if q == nil {
		return nil
	}
	hard := q.StatusHard
	if hard == nil {
		hard = q.SpecHard
	}
	used := q.StatusUsed
	remainingInt := func(key string, parse func(string) (int64, bool)) *int64 {
		limit, ok := parse(hard[key])
		if !ok {
			return nil
		}
		consumed, _ := parse(used[key])

		return new(max(0, limit-consumed))
	}
	remainingFloat := func(key string) *float64 {
		limit, ok := ParseQuantity(hard[key])
		if !ok {
			return nil
		}
		consumed, _ := ParseQuantity(used[key])

		return new(max(0, limit-consumed))
	}

	return &Headroom{
		CPUMillis:    remainingInt("requests.cpu", ParseCPUMillis),
		MemoryBytes:  remainingFloat("requests.memory"),
		StorageBytes: remainingFloat("requests.storage"),
		PVCCount:     remainingInt("persistentvolumeclaims", ParseCount),
		Pods:         remainingInt("pods", ParseCount),
	}
}

type LimitRangeItem struct {
	Type           string
	DefaultRequest QuotaAmounts
	Default        QuotaAmounts
}

// ContainerDefaults are what the first Container LimitRange injects when a
// manifest omits resources. A small default memory limit OOM-kills a database
// that ships without an explicit resources block.
func ContainerDefaults(ranges [][]LimitRangeItem) *LimitRangeDefaults {
	for _, items := range ranges {
		for _, l := range items {
			if l.Type != "Container" || (l.DefaultRequest == nil && l.Default == nil) {
				continue
			}

			return &LimitRangeDefaults{DefaultRequest: nonnil.Map(l.DefaultRequest), Default: nonnil.Map(l.Default)}
		}
	}

	return nil
}
