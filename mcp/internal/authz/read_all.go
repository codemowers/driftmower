package authz

import "context"

// ReadAll is used only with mutation tools disabled. Impersonation here
// authorizes effective-rights inspection (SelfSubjectRulesReview), not writes.
type ReadAll struct{}

func (ReadAll) MayPerform(_ context.Context, _ Identity, attrs Attributes) Judgement {
	switch attrs.Verb {
	case "get", "list", "watch", "impersonate":
		return Judgement{Verdict: Yes}
	default:
		return Judgement{Verdict: No, Reason: "This MCP access mode is read-only"}
	}
}
