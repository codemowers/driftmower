package workloads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/metadata/metadatainformer"
	"k8s.io/client-go/tools/cache"
)

// errorWindow is how long a list/watch failure marks a source's inventory as
// possibly incomplete.
const errorWindow = 2 * time.Minute

// Cache keeps one cluster-wide informer per source, holding projected
// objects only. Secrets, ConfigMaps and PVCs are watched as metadata, so
// their contents never reach the process.
type Cache struct {
	dynamic   dynamic.Interface
	metadata  metadata.Interface
	discovery discovery.DiscoveryInterface
	log       *slog.Logger
	epoch     string
	revision  atomic.Uint64

	mu      sync.RWMutex
	watches []*watch
}

type watch struct {
	source   *Source
	informer cache.SharedIndexInformer
	// failedAt and reason describe the last list/watch failure.
	failedAt atomic.Int64
	reason   atomic.Value
}

func NewCache(dynamicClient dynamic.Interface, metadataClient metadata.Interface, discoveryClient discovery.DiscoveryInterface, log *slog.Logger) *Cache {
	epoch := make([]byte, 6)
	rand.Read(epoch)
	return &Cache{dynamic: dynamicClient, metadata: metadataClient, discovery: discoveryClient, log: log, epoch: hex.EncodeToString(epoch)}
}

// Run watches the built-in sources and, while their APIs are served, the
// optional adapters until ctx is done.
func (c *Cache) Run(ctx context.Context) {
	for _, source := range Sources {
		c.start(ctx, source)
	}
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		for _, source := range []*Source{CertificateSource, CNPGSource} {
			if !c.watching(source) && c.served(source) {
				c.start(ctx, source)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Cache) served(source *Source) bool {
	resources, err := c.discovery.ServerResourcesForGroupVersion(source.APIVersion)
	if err != nil {
		return false
	}
	return slices.ContainsFunc(resources.APIResources, func(r metav1.APIResource) bool {
		return r.Name == source.Resource && r.Kind == source.Kind
	})
}

func (c *Cache) watching(source *Source) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return slices.ContainsFunc(c.watches, func(w *watch) bool { return w.source == source })
}

func (c *Cache) start(ctx context.Context, source *Source) {
	gv, _ := schema.ParseGroupVersion(source.APIVersion)
	gvr := gv.WithResource(source.Resource)
	indexers := cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc}
	w := &watch{source: source}
	if source.MetadataOnly {
		w.informer = metadatainformer.NewFilteredMetadataInformer(c.metadata, gvr, metav1.NamespaceAll, 0, indexers, nil).Informer()
		w.informer.SetTransform(func(obj any) (any, error) {
			if meta, ok := obj.(*metav1.PartialObjectMetadata); ok {
				return projectMetadata(meta), nil
			}
			return obj, nil
		})
	} else {
		w.informer = dynamicinformer.NewFilteredDynamicInformer(c.dynamic, gvr, metav1.NamespaceAll, 0, indexers, nil).Informer()
		w.informer.SetTransform(func(obj any) (any, error) {
			if u, ok := obj.(*unstructured.Unstructured); ok {
				return Project(source, u), nil
			}
			return obj, nil
		})
	}
	w.informer.SetWatchErrorHandlerWithContext(func(ctx context.Context, r *cache.Reflector, err error) {
		reason := "connection or response validation failed"
		if status, ok := err.(apierrors.APIStatus); ok {
			reason = "HTTP " + strconv.Itoa(int(status.Status().Code))
			if apierrors.IsForbidden(err) {
				reason += " (service-account RBAC denied)"
			}
		}
		w.reason.Store(reason)
		w.failedAt.Store(time.Now().Unix())
		cache.DefaultWatchErrorHandler(ctx, r, err)
	})
	bump := func() { c.revision.Add(1) }
	w.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { bump() },
		UpdateFunc: func(any, any) { bump() },
		DeleteFunc: func(any) { bump() },
	})
	c.mu.Lock()
	c.watches = append(c.watches, w)
	c.mu.Unlock()
	go w.informer.RunWithContext(ctx)
	c.log.Info("watching", "resource", gvr.String())
}

// projectMetadata keeps identity, labels, owners and marker annotations.
func projectMetadata(meta *metav1.PartialObjectMetadata) *metav1.PartialObjectMetadata {
	out := &metav1.PartialObjectMetadata{TypeMeta: meta.TypeMeta, ObjectMeta: metav1.ObjectMeta{
		Name: meta.Name, Namespace: meta.Namespace, UID: meta.UID, ResourceVersion: meta.ResourceVersion,
		Labels: meta.Labels, OwnerReferences: meta.OwnerReferences,
	}}
	for _, key := range markerAnnotations {
		if value, ok := meta.Annotations[key]; ok {
			if out.Annotations == nil {
				out.Annotations = map[string]string{}
			}
			out.Annotations[key] = value
		}
	}
	return out
}

// Synced reports whether every started source completed its initial list.
func (c *Cache) Synced() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, w := range c.watches {
		if !w.informer.HasSynced() {
			return false
		}
	}
	return len(c.watches) > 0
}

// Revision changes whenever any watched object changes.
func (c *Cache) Revision() string {
	return c.epoch + ":" + strconv.FormatUint(c.revision.Load(), 10)
}

// Sources lists the watched sources.
func (c *Cache) Sources() []*Source {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]*Source, len(c.watches))
	for i, w := range c.watches {
		out[i] = w.source
	}
	return out
}

// Namespaces lists every namespace holding a watched object.
func (c *Cache) Namespaces() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var out []string
	for _, w := range c.watches {
		out = append(out, w.informer.GetIndexer().ListIndexFuncValues(cache.NamespaceIndex)...)
	}
	slices.Sort(out)
	return slices.Compact(slices.DeleteFunc(out, func(ns string) bool { return ns == "" }))
}

// Snapshot builds the namespace's inventory from the sources permitted
// returns true for. Warnings name sources whose data may be incomplete.
func (c *Cache) Snapshot(namespace string, permitted func(*Source) bool) ([]*Workload, []string) {
	c.mu.RLock()
	watches := slices.Clone(c.watches)
	c.mu.RUnlock()
	warnings := map[string]bool{}
	var lists []List
	for _, w := range watches {
		if !permitted(w.source) {
			continue
		}
		if !w.informer.HasSynced() {
			warnings[fmt.Sprintf("%s: %s list/watch pending; inventory and orphan classification may be incomplete.", namespace, w.source.Resource)] = true
		} else if failedAt := w.failedAt.Load(); failedAt > 0 && time.Since(time.Unix(failedAt, 0)) < errorWindow {
			warnings[fmt.Sprintf("%s: %s list/watch unavailable: %s; inventory and orphan classification may be incomplete.", namespace, w.source.Resource, w.reason.Load())] = true
		}
		items, _ := w.informer.GetIndexer().ByIndex(cache.NamespaceIndex, namespace)
		list := List{Source: w.source}
		for _, item := range items {
			switch obj := item.(type) {
			case *unstructured.Unstructured:
				list.Objects = append(list.Objects, ToObject(w.source, obj))
			case *metav1.PartialObjectMetadata:
				list.Objects = append(list.Objects, &Object{APIVersion: w.source.APIVersion, Kind: w.source.Kind, UID: string(obj.UID),
					Name: obj.Name, Namespace: obj.Namespace, Labels: obj.Labels, Annotations: obj.Annotations, Owners: obj.OwnerReferences})
			}
		}
		lists = append(lists, list)
	}
	workloads := Inventory(namespace, lists, warnings)
	var out []string
	for warning := range warnings {
		out = append(out, warning)
	}
	slices.Sort(out)
	return workloads, out
}
