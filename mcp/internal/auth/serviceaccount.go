package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	authenticationclient "k8s.io/client-go/kubernetes/typed/authentication/v1"

	"github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/codemowers/driftmower-mcp/internal/authz"
)

// TokenReviewer resolves a Kubernetes token through TokenReview.
type TokenReviewer struct {
	client authenticationclient.TokenReviewsGetter
}

func NewTokenReviewer(client authenticationclient.TokenReviewsGetter) *TokenReviewer {
	return &TokenReviewer{client: client}
}

// Review returns the token's status as the API server sees it. Audiences, when
// given, must include one the token was issued for.
func (r *TokenReviewer) Review(ctx context.Context, token string, audiences ...string) (authenticationv1.TokenReviewStatus, error) {
	review, err := r.client.TokenReviews().Create(ctx, &authenticationv1.TokenReview{
		Spec: authenticationv1.TokenReviewSpec{Token: token, Audiences: audiences},
	}, metav1.CreateOptions{})
	if err != nil {
		return authenticationv1.TokenReviewStatus{}, err
	}

	return review.Status, nil
}

var serviceAccountUser = regexp.MustCompile(`^system:serviceaccount:([^:]+):([^:]+)$`)

const serviceAccountClientID = "kubernetes-serviceaccount"

var errServiceAccountDenied = fmt.Errorf("%w: a valid ServiceAccount token bound to this MCP resource is required", auth.ErrInvalidToken)

// VerifyServiceAccount authenticates a ServiceAccount token bound to resource.
// TokenReview, not the token's unverified claims, establishes the identity;
// the audience keeps ordinary Kubernetes API tokens from opening this server.
// It reports ok=false for tokens that are not ServiceAccount tokens, which
// belong to OIDC.
func (r *TokenReviewer) VerifyServiceAccount(ctx context.Context, raw, resource string) (*Caller, *auth.TokenInfo, bool, error) {
	claims, ok := unverifiedClaims(raw)
	if !ok || !strings.HasPrefix(claims.Sub, "system:serviceaccount:") {
		return nil, nil, false, nil
	}
	if !slices.Contains(claims.Aud, resource) {
		return nil, nil, true, errServiceAccountDenied
	}

	status, err := r.Review(ctx, raw, resource)
	if err != nil {
		return nil, nil, true, errServiceAccountDenied
	}
	match := serviceAccountUser.FindStringSubmatch(status.User.Username)
	if !status.Authenticated || match == nil || !slices.Contains(status.Audiences, resource) ||
		!slices.Contains(status.User.Groups, "system:serviceaccounts:"+match[1]) {
		return nil, nil, true, errServiceAccountDenied
	}

	groups := []string{"system:authenticated"}
	for _, g := range status.User.Groups {
		if !slices.Contains(groups, g) {
			groups = append(groups, g)
		}
	}
	user := status.User.Username
	caller := &Caller{
		Sub:            user,
		ClientID:       serviceAccountClientID,
		Groups:         groups,
		IdentityClaims: IdentityClaims{Username: user, Groups: groups},
		Kubernetes:     &authz.Identity{User: user, Groups: groups},
	}
	var exp time.Time
	if claims.Exp > 0 {
		exp = time.Unix(claims.Exp, 0)
	}

	return caller, NewTokenInfo(caller, nil, exp), true, nil
}

type jwtClaims struct {
	Sub string   `json:"sub"`
	Aud audience `json:"aud"`
	Exp int64    `json:"exp"`
}

// audience accepts the single-string and array forms of `aud`.
type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*a = audience{one}

		return nil
	}

	return json.Unmarshal(b, (*[]string)(a))
}

// unverifiedClaims decodes a JWT payload without checking its signature, only
// to route the token; TokenReview does the verification.
func unverifiedClaims(raw string) (jwtClaims, bool) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return jwtClaims{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return jwtClaims{}, false
	}
	var c jwtClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return jwtClaims{}, false
	}

	return c, true
}
