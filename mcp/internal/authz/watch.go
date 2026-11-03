package authz

import (
	"context"
	"log/slog"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/metadata/metadatainformer"
	"k8s.io/client-go/tools/cache"
)

// WatchHooks receive the invalidations the watch derives from cluster events.
type WatchHooks struct {
	// A Role or RoleBinding changed in this namespace, or the namespace was
	// deleted.
	InvalidateNamespace func(namespace string)
	// A cluster-scoped RBAC object changed, or events may have been missed.
	ClearReviews func()
	// A namespace was added, changed or removed.
	NamespacesChanged func()
	// A CustomResourceDefinition changed, so discovery may differ.
	DiscoveryChanged func()
}

var (
	roles               = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"}
	roleBindings        = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"}
	clusterRoles        = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"}
	clusterRoleBindings = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"}
	namespaces          = schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}
	crds                = schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}
)

// StartInvalidationWatch watches RBAC objects, namespaces and CRDs and turns
// their changes into hook calls, so cached reviews and cluster shape follow
// the cluster and the review-cache TTL is only a safety net. It watches
// metadata only, which is all the hooks need. The watches stop when ctx ends.
//
// Objects already present when a watch starts are not events. When a watch
// fails, events may have been missed, so the hook guarding that resource is
// called as if everything changed; the relist that follows reports existing
// objects as updates, which is harmless.
func StartInvalidationWatch(ctx context.Context, client metadata.Interface, hooks WatchHooks, logger *slog.Logger) error {
	factory := metadatainformer.NewSharedInformerFactory(client, 0)

	namespaced := func(_ string, namespace string) {
		if namespace != "" {
			hooks.InvalidateNamespace(namespace)
		} else {
			hooks.ClearReviews()
		}
	}
	clusterWide := func(string, string) { hooks.ClearReviews() }

	targets := []struct {
		gvr      schema.GroupVersionResource
		onEvent  func(eventType, namespace string)
		onResync func()
	}{
		{roles, namespaced, hooks.ClearReviews},
		{roleBindings, namespaced, hooks.ClearReviews},
		{clusterRoles, clusterWide, hooks.ClearReviews},
		{clusterRoleBindings, clusterWide, hooks.ClearReviews},
		{namespaces, func(string, string) { hooks.NamespacesChanged() }, hooks.NamespacesChanged},
		{crds, func(string, string) { hooks.DiscoveryChanged() }, hooks.DiscoveryChanged},
	}

	for _, target := range targets {
		informer := factory.ForResource(target.gvr).Informer()
		gvr := target.gvr
		if err := informer.SetWatchErrorHandlerWithContext(func(ctx context.Context, r *cache.Reflector, err error) {
			logger.Warn("Kubernetes watch interrupted; reconnecting", "resource", gvr.Resource, "error", err)
			target.onResync()
			cache.DefaultWatchErrorHandler(ctx, r, err)
		}); err != nil {
			return err
		}

		onEvent := target.onEvent
		isNamespaces := gvr == namespaces
		if _, err := informer.AddEventHandler(cache.ResourceEventHandlerDetailedFuncs{
			AddFunc: func(obj any, isInInitialList bool) {
				if !isInInitialList {
					onEvent("ADDED", namespaceOf(obj))
				}
			},
			UpdateFunc: func(_, obj any) { onEvent("MODIFIED", namespaceOf(obj)) },
			DeleteFunc: func(obj any) {
				onEvent("DELETED", namespaceOf(obj))
				// Reviews in a deleted namespace are meaningless now.
				if isNamespaces {
					if name := nameOf(obj); name != "" {
						hooks.InvalidateNamespace(name)
					}
				}
			},
		}); err != nil {
			return err
		}
	}

	factory.Start(ctx.Done())
	go func() {
		<-ctx.Done()
		factory.Shutdown()
	}()

	return nil
}

func metaOf(obj any) *metav1.PartialObjectMetadata {
	if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = tombstone.Obj
	}
	m, _ := obj.(*metav1.PartialObjectMetadata)

	return m
}

func namespaceOf(obj any) string {
	if m := metaOf(obj); m != nil {
		return m.Namespace
	}

	return ""
}

func nameOf(obj any) string {
	if m := metaOf(obj); m != nil {
		return m.Name
	}

	return ""
}
