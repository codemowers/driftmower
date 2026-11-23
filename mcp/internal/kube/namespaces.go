package kube

import (
	"context"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/codemowers/driftmower/mcp/internal/ttlcache"
)

// namespaceListTTL bounds staleness when no namespace watch refreshes the list.
const namespaceListTTL = time.Minute

// NamespaceLister lists namespace names, cached briefly and shared by
// concurrent callers.
type NamespaceLister struct {
	memo *ttlcache.Memo[[]string]
}

func NewNamespaceLister(client kubernetes.Interface) *NamespaceLister {
	load := func(ctx context.Context) ([]string, error) {
		return Collect(ctx, func(ctx context.Context, opts metav1.ListOptions) ([]string, string, error) {
			list, err := client.CoreV1().Namespaces().List(ctx, opts)
			if err != nil {
				return nil, "", err
			}
			names := make([]string, 0, len(list.Items))
			for _, ns := range list.Items {
				names = append(names, ns.Name)
			}

			return names, list.Continue, nil
		}, ListOptions{What: "Namespace listing"})
	}

	return &NamespaceLister{memo: ttlcache.NewMemo(namespaceListTTL, load, nil)}
}

// List returns every namespace name. Callers must not modify the result.
func (l *NamespaceLister) List(ctx context.Context) ([]string, error) {
	return l.memo.Get(ctx)
}

func (l *NamespaceLister) Invalidate() {
	l.memo.Invalidate()
}

func (l *NamespaceLister) Stats() ttlcache.Stats { return l.memo.Stats() }
