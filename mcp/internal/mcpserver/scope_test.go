package mcpserver

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/tenancy"
)

type recordingJudge struct {
	mu     sync.Mutex
	answer func(authz.Identity, authz.Attributes) authz.Verdict
	seen   []authz.Attributes
	who    []authz.Identity
}

func (r *recordingJudge) MayPerform(_ context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen, r.who = append(r.seen, a), append(r.who, id)

	return authz.Judgement{Verdict: r.answer(id, a)}
}

func request(c *auth.Caller) *mcp.CallToolRequest {
	req := &mcp.CallToolRequest{Extra: &mcp.RequestExtra{}}
	if c != nil {
		req.Extra.TokenInfo = auth.NewTokenInfo(c, nil, time.Now().Add(time.Hour))
	}

	return req
}

func TestResolveScope(t *testing.T) {
	mapping := auth.Mapping{UsernameClaim: "sub", GroupsClaim: "groups", UsernamePrefix: "issuer#"}
	logger := slog.New(slog.DiscardHandler)
	judge := &recordingJudge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Namespace == "b" {
			return authz.Yes
		}

		return authz.No
	}}
	resolver := &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return []string{"a", "b"}, nil }, Judge: judge}
	alice := &auth.Caller{Sub: "alice", IdentityClaims: auth.IdentityClaims{Username: "alice", Groups: []string{"devs"}},
		Namespaces: tenancy.Claim{Namespaces: []string{"a"}, Present: true}}
	ctx := context.Background()

	union := &Tenancy{Policy: tenancy.PolicyUnion, Resolver: resolver, Mapping: mapping, Logger: logger}
	if got := union.resolveScope(ctx, request(nil)); got.Restricted || got.Source != tenancy.Unrestricted || len(judge.seen) != 0 {
		t.Errorf("anonymous = %+v", got)
	}

	claim := &Tenancy{Policy: tenancy.PolicyClaim, Resolver: resolver, Mapping: mapping, Logger: logger}
	if got := claim.resolveScope(ctx, request(alice)); !slices.Equal(got.Namespaces, []string{"a"}) || got.Source != tenancy.FromClaim || len(judge.seen) != 0 {
		t.Errorf("claim policy = %+v", got)
	}
	if got := claim.resolveScope(ctx, request(&auth.Caller{Sub: "bob"})); got.Source != tenancy.ClaimMissing || !got.Restricted {
		t.Errorf("missing claim = %+v", got)
	}

	got := union.resolveScope(ctx, request(alice))
	if !slices.Equal(got.Namespaces, []string{"a", "b"}) || got.Source != tenancy.Union {
		t.Errorf("union = %+v", got)
	}
	if id := judge.who[0]; id.User != "issuer#alice" || !slices.Equal(id.Groups, []string{"system:authenticated", "devs"}) {
		t.Errorf("reviewed as %+v", id)
	}

	failing := &Tenancy{Policy: tenancy.PolicyUnion, Mapping: mapping, Logger: logger, Resolver: &authz.ScopeResolver{
		ListNamespaces: func(context.Context) ([]string, error) { return nil, errors.New("Kubernetes API returned HTTP 503") },
		Judge:          judge,
	}}
	got = failing.resolveScope(ctx, request(alice))
	if got.Source != tenancy.RBACInconclusive || !slices.Equal(got.Namespaces, []string{"a"}) || got.Detail.RBACError != "Kubernetes API returned HTTP 503" {
		t.Errorf("inconclusive = %+v", got)
	}

	unmapped := union.resolveScope(ctx, request(&auth.Caller{Sub: "carol", Namespaces: tenancy.Claim{Namespaces: []string{"a"}, Present: true}}))
	if unmapped.Source != tenancy.RBACInconclusive || !slices.Equal(unmapped.Namespaces, []string{"a"}) {
		t.Errorf("unmappable identity = %+v", unmapped)
	}
}
