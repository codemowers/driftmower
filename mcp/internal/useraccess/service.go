package useraccess

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/kube"
	"github.com/codemowers/driftmower/mcp/internal/ttlcache"
)

// RulesReviewer answers a SelfSubjectRulesReview in namespace as id.
type RulesReviewer func(ctx context.Context, id authz.Identity, namespace string) (authorizationv1.SubjectRulesReviewStatus, error)

// Service lists OIDCUsers and evaluates their effective rights for callers
// who may impersonate them.
type Service struct {
	// The server's own clients. OIDCUsers are read with them only after the
	// caller's own RBAC allows it.
	Dynamic   dynamic.Interface
	Discovery discovery.DiscoveryInterface
	Judge     authz.Judge
	// Sweeps namespaces with `list pods` as the target user, to choose where
	// rules reviews are worth sending.
	Scope          *authz.ScopeResolver
	ListNamespaces func(context.Context) ([]string, error)
	Mapping        auth.Mapping
	// Namespace holding the OIDCUsers.
	Namespace string
	// Rules reviews as the target user; NewImpersonatingReviewer in
	// production.
	Rules RulesReviewer
	// Evaluations are reused for this long; zero disables the cache.
	CacheTTL time.Duration
	// Rules reviews in flight at once; defaults to 8.
	Concurrency int

	once    sync.Once
	results *ttlcache.Cache[*Access]
	kindsMu sync.Mutex
	kinds   kindLookup
	kindsAt time.Time
}

func (s *Service) CacheStats() ttlcache.Stats {
	s.once.Do(func() { s.results = ttlcache.New[*Access](max(s.CacheTTL, time.Nanosecond), 256, nil) })
	return s.results.Stats()
}

// NewImpersonatingReviewer sends rules reviews impersonating the user, which
// requires impersonate on users and groups for this server's account.
func NewImpersonatingReviewer(base *rest.Config) RulesReviewer {
	return func(ctx context.Context, id authz.Identity, namespace string) (authorizationv1.SubjectRulesReviewStatus, error) {
		cfg := rest.CopyConfig(base)
		cfg.Impersonate = rest.ImpersonationConfig{UserName: id.User, Groups: id.Groups}
		client, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			return authorizationv1.SubjectRulesReviewStatus{}, err
		}
		review, err := client.AuthorizationV1().SelfSubjectRulesReviews().Create(ctx, &authorizationv1.SelfSubjectRulesReview{
			Spec: authorizationv1.SelfSubjectRulesReviewSpec{Namespace: namespace},
		}, metav1.CreateOptions{})
		if err != nil {
			return authorizationv1.SubjectRulesReviewStatus{}, err
		}

		return review.Status, nil
	}
}

// ErrForbidden reports a caller who may not use this view.
var ErrForbidden = errors.New("not authorized")

func (s *Service) require(ctx context.Context, caller authz.Identity, attrs ...authz.Attributes) error {
	for _, a := range attrs {
		j := s.Judge.MayPerform(ctx, caller, a)
		if j.Verdict != authz.Yes {
			reason := j.Reason
			if reason == "" {
				reason = "Kubernetes RBAC denies " + a.String()
			}

			return fmt.Errorf("%w: %s", ErrForbidden, reason)
		}
	}

	return nil
}

// inspectGate is what a caller needs to see someone's effective rights: to
// read the OIDCUser and to impersonate its user and groups, since that is
// what this server does on the caller's behalf.
func (s *Service) inspectGate(name string) []authz.Attributes {
	return []authz.Attributes{
		{Namespace: s.Namespace, Group: OIDCUsersGVR.Group, Resource: OIDCUsersGVR.Resource, Verb: "get", Name: name},
		{Group: "", Resource: "users", Verb: "impersonate"},
		{Group: "", Resource: "groups", Verb: "impersonate"},
	}
}

// Access is one user's effective rights.
type Access struct {
	User     User           `json:"user"`
	Identity authz.Identity `json:"identity"`
	// Every verb on every resource cluster-wide; the grant lists are then
	// collapsed to that one fact.
	ClusterAdmin bool `json:"clusterAdmin"`
	// Rules from ClusterRoleBindings: they apply in every namespace and to
	// cluster-scoped resources.
	ClusterWide     []Grant            `json:"clusterWide"`
	NonResourceURLs []NonResourceGrant `json:"nonResourceURLs"`
	// Rights in specific namespaces beyond the cluster-wide ones.
	Namespaced []Grant `json:"namespaced"`
	// Namespaces where rules were reviewed: those where the user may list
	// pods. Others were not examined.
	Examined []string `json:"examined"`
	// Namespaces the cluster has, and the pod probe skipped.
	TotalNamespaces int `json:"totalNamespaces"`
	// The authorizer said its rules may be incomplete in these namespaces,
	// such as with a webhook authorizer; "" stands for the cluster-wide
	// review.
	Incomplete []string `json:"incomplete"`
	Warnings   []string `json:"warnings"`
	// When the evaluation ran; a cached answer keeps its original time.
	EvaluatedAt time.Time `json:"evaluatedAt"`
}

// Inspect evaluates name's effective rights for caller. refresh skips the
// cache.
func (s *Service) Inspect(ctx context.Context, caller authz.Identity, name string, refresh bool) (*Access, error) {
	if err := s.require(ctx, caller, s.inspectGate(name)...); err != nil {
		return nil, err
	}
	user, err := s.getUser(ctx, name)
	if err != nil {
		return nil, err
	}
	id, err := Identity(user, s.Mapping)
	if err != nil {
		return nil, err
	}

	return s.cached(ctx, user, id, refresh)
}

// Self evaluates the caller's own effective rights, for the identity the API
// server sees in their token. Everyone may review their own rules, so no
// permission is required.
func (s *Service) Self(ctx context.Context, caller authz.Identity, refresh bool) (*Access, error) {
	return s.cached(ctx, User{Name: caller.User, Emails: []string{}, Groups: caller.Groups}, caller, refresh)
}

func (s *Service) cached(ctx context.Context, user User, id authz.Identity, refresh bool) (*Access, error) {
	s.once.Do(func() { s.results = ttlcache.New[*Access](max(s.CacheTTL, time.Nanosecond), 256, nil) })
	key := id.Key()
	if !refresh && s.CacheTTL > 0 {
		if a, ok := s.results.Get(key); ok {
			// The identity is the same, but profile fields may have changed.
			copied := *a
			copied.User = user

			return &copied, nil
		}
	}
	a, err := s.evaluate(ctx, user, id)
	if err != nil {
		return nil, err
	}
	if user.Namespace != "" && user.Type != "ServiceAccount" && s.Mapping.GroupsClaim != "" && s.Mapping.GroupsClaim != "groups" {
		a.Warnings = append(a.Warnings, "Groups are taken from the OIDCUser, but the API server reads them from the "+
			s.Mapping.GroupsClaim+" claim; they may differ from what this user's tokens carry.")
	}
	if s.CacheTTL > 0 {
		s.results.Set(key, a)
	}

	return a, nil
}

func (s *Service) evaluate(ctx context.Context, user User, id authz.Identity) (*Access, error) {
	a := &Access{User: user, Identity: id, ClusterWide: []Grant{}, NonResourceURLs: []NonResourceGrant{}, Namespaced: []Grant{},
		Examined: []string{}, Incomplete: []string{}, Warnings: []string{}, EvaluatedAt: time.Now().UTC()}
	all, err := s.ListNamespaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}
	a.TotalNamespaces = len(all)
	kinds := s.kindLookup()

	// A namespace with no RoleBindings yields exactly the ClusterRoleBinding
	// rules. The authorizer does not require the namespace to exist.
	probe := probeNamespace(all)
	base, err := s.Rules(ctx, id, probe)
	if err != nil {
		return nil, fmt.Errorf("cluster-wide rules review as %s: %w", id.User, err)
	}
	if base.Incomplete {
		a.Incomplete = append(a.Incomplete, "")
	}
	if base.EvaluationError != "" {
		a.Warnings = append(a.Warnings, "Cluster-wide review: "+base.EvaluationError)
	}
	baseline := atoms(base.ResourceRules)
	a.NonResourceURLs = nonResourceGrants(base.NonResourceRules)
	if isClusterAdmin(baseline) {
		a.ClusterAdmin = true
		a.ClusterWide = []Grant{{Group: "*", Resource: "*", Verbs: []string{"*"}}}

		return a, nil
	}
	a.ClusterWide = clusterGrants(baseline, kinds)

	scope, err := s.Scope.Resolve(ctx, id, nil)
	if err != nil {
		return nil, fmt.Errorf("namespace probe as %s: %w", id.User, err)
	}
	if len(scope.Unknown) > 0 {
		a.Warnings = append(a.Warnings, fmt.Sprintf("Pod visibility could not be evaluated in %d namespace(s); they were not examined: %s.",
			len(scope.Unknown), strings.Join(scope.Unknown, ", ")))
	}
	if scope.Truncated {
		a.Warnings = append(a.Warnings, fmt.Sprintf("Only the first %d of %d namespaces were probed.", len(scope.Namespaces)+len(scope.Unknown), scope.Total))
	}
	candidates := scope.Namespaces
	if scope.ClusterWide {
		// Pods are visible everywhere through cluster-wide rules; every
		// namespace may still add rights of its own.
		candidates = all
	}

	concurrency := s.Concurrency
	if concurrency <= 0 {
		concurrency = 8
	}
	statuses := make([]authorizationv1.SubjectRulesReviewStatus, len(candidates))
	errs := make([]error, len(candidates))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(concurrency)
	for i, ns := range candidates {
		g.Go(func() error {
			statuses[i], errs[i] = s.Rules(gctx, id, ns)

			return nil
		})
	}
	_ = g.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	extras := map[string][]atom{}
	for i, ns := range candidates {
		if errs[i] != nil {
			a.Warnings = append(a.Warnings, ns+": rules review failed: "+errs[i].Error())

			continue
		}
		a.Examined = append(a.Examined, ns)
		st := statuses[i]
		if st.Incomplete {
			a.Incomplete = append(a.Incomplete, ns)
		}
		if st.EvaluationError != "" {
			a.Warnings = append(a.Warnings, ns+": "+st.EvaluationError)
		}
		if extra := subtract(atoms(st.ResourceRules), baseline); len(extra) > 0 {
			extras[ns] = extra
		}
	}
	a.Namespaced = namespacedGrants(extras, kinds)

	return a, nil
}

const probeBase = "driftmower-rules-baseline"

// probeNamespace returns a namespace name the cluster does not have.
func probeNamespace(existing []string) string {
	name := probeBase
	for slices.Contains(existing, name) {
		name = probeBase + "-" + strings.ToLower(rand.Text()[:8])
	}

	return name
}

type kindInfo struct {
	kind       string
	namespaced bool
}

// kindLookup maps `<group>/<plural>` to its kind.
type kindLookup map[string]kindInfo

const kindsTTL = 10 * time.Minute

// kindLookup returns discovery's kinds, refreshed every kindsTTL. A failed
// discovery leaves resources without kinds rather than failing the view.
func (s *Service) kindLookup() kindLookup {
	if s.Discovery == nil {
		return nil
	}
	s.kindsMu.Lock()
	defer s.kindsMu.Unlock()
	if s.kinds != nil && time.Since(s.kindsAt) < kindsTTL {
		return s.kinds
	}
	surface, err := kube.LoadAPISurface(s.Discovery)
	if err != nil {
		return s.kinds
	}
	kinds := kindLookup{}
	for _, r := range surface.ByKind {
		kinds[r.Group+"/"+r.Plural] = kindInfo{kind: r.Kind, namespaced: r.Namespaced}
	}
	s.kinds, s.kindsAt = kinds, time.Now()

	return kinds
}
