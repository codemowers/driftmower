package kube

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ListOptions bounds a paged listing.
type ListOptions struct {
	// Items per page; defaults to 500.
	Limit int64
	// Pages read before giving up; defaults to 20.
	MaxPages int
	// Named in the error so an operator knows which listing outgrew the bound.
	What string
}

// PageFunc reads one page and returns its items and continue token.
type PageFunc[T any] func(ctx context.Context, opts metav1.ListOptions) (items []T, continueToken string, err error)

// Collect reads every page of a collection. It refuses to return a partial
// result: a truncated namespace or policy list would read as "these are all",
// which is the wrong answer to give an agent.
func Collect[T any](ctx context.Context, page PageFunc[T], opts ListOptions) ([]T, error) {
	limit, maxPages, what := opts.Limit, opts.MaxPages, opts.What
	if limit <= 0 {
		limit = 500
	}
	if maxPages <= 0 {
		maxPages = 20
	}
	if what == "" {
		what = "Kubernetes listing"
	}

	var results []T
	cont := ""
	for range maxPages {
		items, next, err := page(ctx, metav1.ListOptions{Limit: limit, Continue: cont})
		if err != nil {
			return nil, err
		}
		results = append(results, items...)
		if next == "" {
			return results, nil
		}
		cont = next
	}

	return nil, fmt.Errorf("%s exceeds %d pages; refusing to return an incomplete list", what, maxPages)
}
