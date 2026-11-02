package workloads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/metadata/metadatainformer"
	"k8s.io/client-go/tools/cache"

	"github.com/codemowers/driftmower-mcp/internal/authz"
)

// syncTimeout bounds how long a first request waits for a collection's
// initial list. A collection still listing afterwards is reported as
// incomplete rather than delaying the answer.
const syncTimeout = 15 * time.Second

// Cache holds one cluster-wide list-and-watch per collection, started on the
// first request. Objects are reduced to references before they are stored;
// Secrets, ConfigMaps and PVCs are read as metadata only, so their data never
// enters memory.
type Cache struct {
	Kubernetes kubernetes.Interface
	Metadata   metadata.Interface
	Dynamic    dynamic.Interface
	// Decides whether the optional CRD adapters are watched.
	Discovery discovery.DiscoveryInterface
	Judge     authz.Judge
	Scope     *authz.ScopeResolver
	Logger    *slog.Logger

	ctx      context.Context
	once     sync.Once
	targets  []*target
	epoch    string
	revision atomic.Uint64
}

type target struct {
	source   Source
	informer cache.SharedIndexInformer
	mu       sync.Mutex
	warning  string
}

func (t *target) setWarning(w string) {
	t.mu.Lock()
	t.warning = w
	t.mu.Unlock()
}

func (t *target) getWarning() string {
	t.mu.Lock()
	defer t.mu.Unlock()

	return t.warning
}

// Start records the lifetime of the watches; they begin on first use.
func (c *Cache) Start(ctx context.Context) {
	c.ctx = ctx
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	c.epoch = hex.EncodeToString(b)
}

func (c *Cache) initialize() {
	c.once.Do(func() {
		typed := informers.NewSharedInformerFactory(c.Kubernetes, 0)
		meta := metadatainformer.NewSharedInformerFactory(c.Metadata, 0)
		dyn := dynamicinformer.NewDynamicSharedInformerFactory(c.Dynamic, 0)

		sources := slices.Clone(Sources)
		// Optional fixed adapters; unavailable APIs create no watch.
		for _, s := range []Source{CertificateSource, CNPGSource} {
			list, err := c.Discovery.ServerResourcesForGroupVersion(s.APIVersion())
			if err == nil && slices.ContainsFunc(list.APIResources, func(r metav1.APIResource) bool {
				return r.Name == s.GVR.Resource && r.Kind == s.Kind
			}) {
				sources = append(sources, s)
			}
		}

		for _, s := range sources {
			t := &target{source: s}
			switch {
			case s.MetadataOnly:
				t.informer = meta.ForResource(s.GVR).Informer()
			case s.GVR.Group == CertificateSource.GVR.Group || s.GVR.Group == CNPGSource.GVR.Group:
				t.informer = dyn.ForResource(s.GVR).Informer()
			default:
				gi, err := typed.ForResource(s.GVR)
				if err != nil {
					c.Logger.Error("no informer for workload source", "resource", s.GVR.Resource, "error", err)

					continue
				}
				t.informer = gi.Informer()
			}
			c.wire(t)
			c.targets = append(c.targets, t)
		}

		typed.Start(c.ctx.Done())
		meta.Start(c.ctx.Done())
		dyn.Start(c.ctx.Done())
		go func() {
			<-c.ctx.Done()
			typed.Shutdown()
			meta.Shutdown()
			dyn.Shutdown()
		}()

		// Wait for every first list, or its failure, within the bound.
		deadline := time.Now().Add(syncTimeout)
		for _, t := range c.targets {
			for !t.informer.HasSynced() && t.getWarning() == "" && time.Now().Before(deadline) && c.ctx.Err() == nil {
				time.Sleep(20 * time.Millisecond)
			}
			if !t.informer.HasSynced() && t.getWarning() == "" {
				t.setWarning("list/watch unavailable: initial list still in progress; inventory and orphan classification may be incomplete.")
			}
		}
	})
}

func (c *Cache) wire(t *target) {
	src := t.source
	_ = t.informer.SetTransform(func(obj any) (any, error) {
		if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			return tomb, nil
		}
		n, err := Project(src, obj)
		if err != nil {
			c.Logger.Warn("dropping malformed workload object", "resource", src.GVR.Resource, "error", err)

			return obj, nil
		}

		return n, nil
	})
	changed := func() {
		c.revision.Add(1)
		t.setWarning("")
	}
	_, _ = t.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { changed() },
		UpdateFunc: func(any, any) { changed() },
		DeleteFunc: func(any) { changed() },
	})
	_ = t.informer.SetWatchErrorHandlerWithContext(func(ctx context.Context, r *cache.Reflector, err error) {
		// Upstream bodies are not exposed; a stale inventory is labelled.
		t.setWarning("list/watch unavailable: " + failureReason(err) + "; inventory and orphan classification may be incomplete.")
		cache.DefaultWatchErrorHandler(ctx, r, err)
	})
}

func failureReason(err error) string {
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		code := int(status.Status().Code)
		reason := "HTTP " + strconv.Itoa(code)
		switch code {
		case 403:
			reason += " (service-account RBAC denied)"
		case 406:
			reason += " (metadata representation rejected)"
		}

		return reason
	}

	return "connection or response validation failed"
}

func (c *Cache) version() string {
	return c.epoch + ":" + strconv.FormatUint(c.revision.Load(), 10)
}

// List returns the caller's inventory for one namespace, or for every
// namespace the caller may see when namespace is empty.
func (c *Cache) List(ctx context.Context, namespace string, id authz.Identity) (*Inventory, error) {
	if c.ctx == nil || c.ctx.Err() != nil {
		return nil, errors.New("workload cache is stopped")
	}
	var candidates, warnings []string
	if namespace != "" {
		candidates = []string{namespace}
	} else {
		scope, err := c.Scope.Resolve(ctx, id, nil)
		if err != nil {
			return nil, err
		}
		candidates = scope.Namespaces
		if len(scope.Unknown) > 0 {
			warnings = append(warnings, fmt.Sprintf("Access could not be evaluated for %d namespaces; excluded from inventory.", len(scope.Unknown)))
		}
		if scope.Truncated {
			warnings = append(warnings, "Namespace discovery truncated; specify a namespace for complete inventory.")
		}
	}

	inv := &Inventory{Workloads: []*Workload{}}
	for _, ns := range slices.Compact(slices.Sorted(slices.Values(candidates))) {
		workloads, w, err := c.snapshot(ctx, ns, id)
		if err != nil {
			return nil, err
		}
		inv.Workloads = append(inv.Workloads, workloads...)
		warnings = append(warnings, w...)
	}
	if len(warnings) > 0 {
		slices.Sort(warnings)
		inv.Warnings = slices.Compact(warnings)
	}
	inv.Revision = c.version()

	return inv, nil
}

func (c *Cache) snapshot(ctx context.Context, ns string, id authz.Identity) ([]*Workload, []string, error) {
	// A cached graph is not authorization: the caller's own list permission
	// gates the namespace and then each collection.
	if c.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}).Verdict != authz.Yes {
		return nil, []string{ns + ": list pods is not authorized; inventory withheld."}, nil
	}
	c.initialize()

	permitted := make([]bool, len(c.targets))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(4)
	for i, t := range c.targets {
		g.Go(func() error {
			permitted[i] = c.Judge.MayPerform(gctx, id, authz.Attributes{
				Namespace: ns, Group: t.source.GVR.Group, Resource: t.source.GVR.Resource, Verb: "list",
			}).Verdict == authz.Yes

			return nil
		})
	}
	_ = g.Wait()
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}

	warnings := map[string]bool{}
	var lists []SourceItems
	for i, t := range c.targets {
		if !permitted[i] {
			warnings[ns+": list "+t.source.GVR.Resource+" is not authorized; related inventory may be incomplete."] = true

			continue
		}
		if w := t.getWarning(); w != "" {
			warnings[ns+": "+t.source.GVR.Resource+" "+w] = true
		}
		objs, err := t.informer.GetIndexer().ByIndex(cache.NamespaceIndex, ns)
		if err != nil {
			return nil, nil, err
		}
		items := make([]*Node, 0, len(objs))
		for _, o := range objs {
			if n, ok := o.(*Node); ok {
				items = append(items, n)
			}
		}
		slices.SortFunc(items, func(a, b *Node) int { return strings.Compare(string(a.UID), string(b.UID)) })
		lists = append(lists, SourceItems{Source: t.source, Items: items})
	}

	workloads := BuildInventory(ns, lists, warnings)
	out := make([]string, 0, len(warnings))
	for w := range warnings {
		out = append(out, w)
	}

	return workloads, out, nil
}
