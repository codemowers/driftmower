package provisioning

import (
	"fmt"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// The access matrix and everything derived from it. Every cell is the cluster
// authorizer's own answer to one SubjectAccessReview, so nothing here reads a
// Role or RoleBinding and nothing can be wrong about aggregation, wildcards or
// webhook authorizers. The only judgement is in the folds below.

// ResourceKey is "group/resource"; the core group is empty, so pods are
// "/pods".
func ResourceKey(group, resource string) string {
	return group + "/" + resource
}

// TargetResource is one resource an offering's sample manifest creates.
// Resource is "" for the primary kind when the cluster does not serve it.
type TargetResource struct {
	Group    string
	Resource string
	Version  string
	Reason   string
}

// ProvisionTarget is every resource an offering's sample creates.
type ProvisionTarget struct {
	ID        OfferingID
	Resources []TargetResource
}

var (
	viewKey  = ResourceKey("", "pods")
	editKey  = ResourceKey("apps", "deployments")
	adminKey = ResourceKey("rbac.authorization.k8s.io", "rolebindings")
)

func cell(matrix map[string]map[Verb]Verdict, key string, verb Verb) Verdict {
	if v, ok := matrix[key][verb]; ok {
		return v
	}

	return authz.Unknown
}

func qualified(resource, group string) string {
	if group == "" {
		group = "core"
	}

	return resource + "." + group
}

// SummariseMatrix folds the matrix into view/edit/admin, per-offering create
// verdicts and counts.
func SummariseMatrix(matrix map[string]map[Verb]Verdict, targets []ProvisionTarget) AccessProfile {
	byVerb := map[Verb]int{}
	for _, v := range Verbs {
		byVerb[v] = 0
	}
	unknown := 0
	for _, verdicts := range matrix {
		for _, verb := range Verbs {
			switch verdicts[verb] {
			case authz.Yes:
				byVerb[verb]++
			case authz.Unknown:
				unknown++
			}
		}
	}

	provision := map[OfferingID]Verdict{}
	detail := map[OfferingID][]ProvisionRow{}
	for _, t := range targets {
		rows := make([]ProvisionRow, 0, len(t.Resources))
		for _, r := range t.Resources {
			if r.Resource == "" {
				reason := r.Reason
				if reason == "" {
					reason = "The cluster does not serve this " + r.Group + " resource, so its name is unknown"
				}
				rows = append(rows, ProvisionRow{Resource: "?." + r.Group, Verdict: authz.Unknown, Reason: &reason})

				continue
			}
			verdict := cell(matrix, ResourceKey(r.Group, r.Resource), "create")
			row := ProvisionRow{Resource: qualified(r.Resource, r.Group), Verdict: verdict}
			switch verdict {
			case authz.No:
				row.Reason = new("Kubernetes RBAC denies create " + qualified(r.Resource, r.Group))
			case authz.Unknown:
				row.Reason = new("The access review for this resource could not be evaluated")
			}
			rows = append(rows, row)
		}
		detail[t.ID] = rows
		switch {
		case !slices.ContainsFunc(rows, func(r ProvisionRow) bool { return r.Verdict != authz.Yes }):
			provision[t.ID] = authz.Yes
		case slices.ContainsFunc(rows, func(r ProvisionRow) bool { return r.Verdict == authz.Unknown }):
			provision[t.ID] = authz.Unknown
		default:
			provision[t.ID] = authz.No
		}
	}

	return AccessProfile{
		Matrix:          matrix,
		View:            cell(matrix, viewKey, "list"),
		Edit:            cell(matrix, editKey, "create"),
		Admin:           cell(matrix, adminKey, "create"),
		Provision:       provision,
		ProvisionDetail: detail,
		Summary:         AccessSummary{ResourceTypes: len(matrix), ByVerb: byVerb, Unknown: unknown},
	}
}

// ComposeCreateVerdict checks admission denials first and on purpose: a
// policy can reject what RBAC allows, and RBAC-only is the optimistic
// direction, the one that wastes a beginner's afternoon.
func ComposeCreateVerdict(rbac authz.Judgement, denials []Denial, what string, constraints []Denial) VerdictReason {
	if len(denials) > 0 {
		d := denials[0]
		said := make([]string, len(d.Messages))
		for i, m := range d.Messages {
			said[i] = strings.TrimSuffix(m, ".")
		}

		return VerdictReason{Verdict: authz.No, Reason: fmt.Sprintf(
			"An enforced admission policy (%s) governs creating %s: %s. "+
				"An admission policy overrides your role, so having permission is not enough here; this needs someone with platform access.",
			d.Policy, what, strings.Join(said, ". "))}
	}

	switch rbac.Verdict {
	case authz.Yes:
		if len(constraints) > 0 {
			return VerdictReason{Verdict: authz.Yes, Reason: "Kubernetes RBAC allows creating " + what + ". " + ConstraintSentence(constraints)}
		}

		return VerdictReason{Verdict: authz.Yes, Reason: "Kubernetes RBAC allows creating " + what + ", and no enforced admission policy governs it."}
	case authz.No:
		reason := rbac.Reason
		if reason == "" {
			reason = "Kubernetes RBAC denies creating " + what + "."
		}

		return VerdictReason{Verdict: authz.No, Reason: reason}
	default:
		reason := rbac.Reason
		if reason == "" {
			reason = "The access review could not be evaluated"
		}
		reason += ". Run `kubectl auth can-i create " + what + "` to check."
		if len(constraints) > 0 {
			reason += " " + ConstraintSentence(constraints)
		}

		return VerdictReason{Verdict: authz.Unknown, Reason: reason}
	}
}

// ConstraintSentence names policies that check the manifest itself. Their
// rules are not repeated: a rejected apply carries the policy's own
// explanation.
func ConstraintSentence(constraints []Denial) string {
	names := make([]string, len(constraints))
	for i, c := range constraints {
		names[i] = c.Policy
	}

	return "Enforced admission policies (" + strings.Join(names, ", ") + ") validate the manifest and reject an invalid one with an explanation."
}

// MayCreateVerdict folds every resource an offering's sample would create,
// with admission on top of the primary kind.
func MayCreateVerdict(profile *AccessProfile, target *ProvisionTarget, denials []Denial, what string, constraints []Denial) VerdictReason {
	if target == nil {
		return VerdictReason{Verdict: authz.Unknown, Reason: "No offering selected yet, so nothing has been checked."}
	}
	if profile == nil {
		return VerdictReason{Verdict: authz.Unknown, Reason: "The call carried no verified caller, so permission was not checked. " +
			"Run `kubectl auth can-i create " + what + "` to check."}
	}
	// Not served: there is nothing to create, which is not a permission question.
	if len(target.Resources) > 0 && target.Resources[0].Resource == "" {
		primary := target.Resources[0]
		reason := primary.Reason
		if reason == "" {
			reason = "The cluster does not serve this " + primary.Group + " resource, so there is nothing to create yet."
		}

		return VerdictReason{Verdict: authz.Unknown, Reason: reason}
	}

	var blocking, uncertain []string
	for _, row := range profile.ProvisionDetail[target.ID] {
		switch row.Verdict {
		case authz.No:
			blocking = append(blocking, row.Resource)
		case authz.Unknown:
			uncertain = append(uncertain, row.Resource)
		}
	}
	rbac := authz.Judgement{Verdict: authz.Yes}
	switch {
	case len(blocking) > 0:
		rbac = authz.Judgement{Verdict: authz.No, Reason: "Kubernetes RBAC denies create on " + strings.Join(blocking, ", ")}
	case len(uncertain) > 0:
		rbac = authz.Judgement{Verdict: authz.Unknown, Reason: "The access review for " + strings.Join(uncertain, ", ") + " could not be evaluated"}
	}

	return ComposeCreateVerdict(rbac, denials, what, constraints)
}
