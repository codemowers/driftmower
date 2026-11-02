package provisioning

import (
	"slices"
)

// MutatingAdmissionPolicies rewrite an object on its way in, so what the
// cluster stores is not what the caller applied. A default that points at
// something which must already exist turns a manifest that looks complete into
// one that stalls after admission. As with validating policies the CEL is not
// evaluated: a policy reports what it mutates and its author's description.

type MutatingPolicy struct {
	Name              string
	Description       string
	MatchPolicy       string
	ResourceRules     []ResourceRule
	NamespaceSelector *LabelSelector
}

type MutatingBinding struct {
	PolicyName        string
	NamespaceSelector *LabelSelector
}

type MutationFact struct {
	Name        string
	Description *string
	Guards      []GuardedOperation
	// The policy or every binding narrows it to selected namespaces, so it may
	// not apply in the caller's.
	NamespaceScoped bool
}

// AdmissionDefault is what an offering's resources become on create, per
// policy.
type AdmissionDefault struct {
	Policy string `json:"policy"`
	// "clusters.postgresql.cnpg.io"
	Resource        string  `json:"resource"`
	Description     *string `json:"description"`
	NamespaceScoped bool    `json:"namespaceScoped"`
}

// ToMutationFacts keeps bound policies only: an unbound one does nothing.
func ToMutationFacts(policies []MutatingPolicy, bindings []MutatingBinding) []MutationFact {
	facts := []MutationFact{}
	for _, p := range policies {
		if p.Name == "" {
			continue
		}
		var bound []MutatingBinding
		for _, b := range bindings {
			if b.PolicyName == p.Name {
				bound = append(bound, b)
			}
		}
		if len(bound) == 0 {
			continue
		}
		allScoped := !slices.ContainsFunc(bound, func(b MutatingBinding) bool { return !b.NamespaceSelector.selectsSomething() })
		facts = append(facts, MutationFact{
			Name:            p.Name,
			Description:     strOrNil(foldSpace(p.Description)),
			Guards:          guardsOf(p.ResourceRules, p.MatchPolicy),
			NamespaceScoped: p.NamespaceSelector.selectsSomething() || allScoped,
		})
	}
	slices.SortStableFunc(facts, func(a, b MutationFact) int { return localeCompare(a.Name, b.Name) })

	return facts
}

// MutationsOf lists every bound policy that rewrites this operation.
func MutationsOf(facts []MutationFact, op Operation) []AdmissionDefault {
	out := []AdmissionDefault{}
	for _, f := range facts {
		if slices.ContainsFunc(f.Guards, func(g GuardedOperation) bool { return guardMatches(g, op) }) {
			out = append(out, AdmissionDefault{
				Policy:          f.Name,
				Resource:        qualified(op.Resource, op.Group),
				Description:     f.Description,
				NamespaceScoped: f.NamespaceScoped,
			})
		}
	}

	return out
}

// DefaultsFor lists the mutations applied when an offering is created.
func DefaultsFor(facts []MutationFact, target ProvisionTarget) []AdmissionDefault {
	out := []AdmissionDefault{}
	for _, r := range target.Resources {
		if r.Resource != "" {
			out = append(out, MutationsOf(facts, Operation{Group: r.Group, Resource: r.Resource, Operation: "CREATE", Version: r.Version})...)
		}
	}

	return out
}
