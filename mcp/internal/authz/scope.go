package authz

import (
	"context"
	"slices"

	"golang.org/x/sync/errgroup"
)

// VisibilityProbe decides whether a namespace is in a caller's world: `list
// pods`, the weakest verb that means "you can see what runs here". It is only
// a visibility test. Nothing downstream may read a namespace being in scope as
// permission to change anything in it; write-adjacent answers ask the exact
// verb and resource separately.
var VisibilityProbe = Attributes{Group: "", Resource: "pods", Verb: "list"}

// RBACScope is the set of namespaces the authorizer lets a caller see.
type RBACScope struct {
	// Namespaces where the review answered yes, sorted.
	Namespaces []string `json:"namespaces"`
	// Namespaces where the review could not be evaluated. Excluded, not denied.
	Unknown []string `json:"unknown"`
	// The caller may list pods in every namespace, so the per-namespace sweep
	// was skipped.
	ClusterWide bool `json:"clusterWide"`
	// Namespaces the cluster reported.
	Total int `json:"total"`
	// The cluster has more namespaces than the sweep bound; only the first
	// MaxNamespaces (preferred ones first, then alphabetical) were checked.
	Truncated bool `json:"truncated"`
}

// ScopeResolver sweeps namespaces with the visibility probe.
type ScopeResolver struct {
	ListNamespaces func(context.Context) ([]string, error)
	Judge          Judge
	// Reviews in flight at once; defaults to 16.
	Concurrency int
	// Namespaces reviewed per sweep; defaults to 2000.
	MaxNamespaces int
}

// Resolve returns the namespaces id may see. Namespaces in preferred are
// checked first when the sweep is truncated.
func (r *ScopeResolver) Resolve(ctx context.Context, id Identity, preferred []string) (RBACScope, error) {
	concurrency, maxNamespaces := r.Concurrency, r.MaxNamespaces
	if concurrency <= 0 {
		concurrency = 16
	}
	if maxNamespaces <= 0 {
		maxNamespaces = 2000
	}

	// No namespace in the review means "in all namespaces", which only a
	// ClusterRoleBinding satisfies. One review instead of one per namespace.
	clusterWide := r.Judge.MayPerform(ctx, id, VisibilityProbe)
	listed, err := r.ListNamespaces(ctx)
	if err != nil {
		return RBACScope{}, err
	}
	all := slices.Sorted(slices.Values(listed))

	if clusterWide.Verdict == Yes {
		return RBACScope{Namespaces: all, Unknown: []string{}, ClusterWide: true, Total: len(all)}, nil
	}

	isPreferred := make(map[string]bool, len(preferred))
	for _, ns := range preferred {
		isPreferred[ns] = true
	}
	ordered := make([]string, 0, len(all))
	for _, ns := range all {
		if isPreferred[ns] {
			ordered = append(ordered, ns)
		}
	}
	for _, ns := range all {
		if !isPreferred[ns] {
			ordered = append(ordered, ns)
		}
	}
	candidates := ordered[:min(len(ordered), maxNamespaces)]

	verdicts := make([]Verdict, len(candidates))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(concurrency)
	for i, ns := range candidates {
		g.Go(func() error {
			probe := VisibilityProbe
			probe.Namespace = ns
			verdicts[i] = r.Judge.MayPerform(gctx, id, probe).Verdict

			return nil
		})
	}
	_ = g.Wait()
	if err := ctx.Err(); err != nil {
		return RBACScope{}, err
	}

	scope := RBACScope{Namespaces: []string{}, Unknown: []string{}, Total: len(all), Truncated: len(all) > len(candidates)}
	for i, v := range verdicts {
		switch v {
		case Yes:
			scope.Namespaces = append(scope.Namespaces, candidates[i])
		case Unknown:
			scope.Unknown = append(scope.Unknown, candidates[i])
		}
	}
	slices.Sort(scope.Namespaces)
	slices.Sort(scope.Unknown)

	return scope, nil
}
