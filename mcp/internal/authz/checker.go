package authz

import (
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// Verdict is a three-valued answer to "may this caller do X". Unknown is a
// first-class outcome, never collapsed into No: an agent must be able to tell
// "denied" from "could not be evaluated", because only one of them is fixed by
// asking for permission.
type Verdict string

const (
	Yes     Verdict = "yes"
	No      Verdict = "no"
	Unknown Verdict = "unknown"
)

// Judgement is a verdict with the reason for anything but Yes.
type Judgement struct {
	Verdict Verdict `json:"verdict"`
	Reason  string  `json:"reason,omitempty"`
}

type Judge interface {
	MayPerform(ctx context.Context, id Identity, attrs Attributes) Judgement
}

// Checker turns review answers and errors into judgements.
type Checker struct {
	reviewer Reviewer
}

func NewChecker(reviewer Reviewer) *Checker {
	return &Checker{reviewer: reviewer}
}

const maxReasonLength = 200

func (c *Checker) MayPerform(ctx context.Context, id Identity, attrs Attributes) Judgement {
	allowed, err := c.reviewer.Allowed(ctx, id, attrs)
	switch {
	case err != nil:
		return Judgement{Verdict: Unknown, Reason: inconclusiveReason(err)}
	case allowed:
		return Judgement{Verdict: Yes}
	default:
		return Judgement{Verdict: No, Reason: "Kubernetes RBAC denies " + attrs.String()}
	}
}

// A 403 on the review itself means this server's ServiceAccount may not create
// SubjectAccessReviews: a deployment problem, not a verdict about the caller.
func inconclusiveReason(err error) string {
	if apierrors.IsForbidden(err) {
		return "The driftmower-mcp service account may not create SubjectAccessReviews (HTTP 403); " +
			"grant create on subjectaccessreviews.authorization.k8s.io"
	}

	// Authorizer errors can carry internal hostnames; show a bounded excerpt.
	message := []rune(err.Error())
	excerpt := string(message)
	if len(message) > maxReasonLength {
		excerpt = string(message[:maxReasonLength]) + "…"
	}

	return "The access review could not be evaluated: " + excerpt
}
