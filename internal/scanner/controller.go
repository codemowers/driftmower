package scanner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
)

var images = schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "containerimages"}

type Controller struct {
	Config   Config
	Kube     kubernetes.Interface
	Dynamic  dynamic.Interface
	Log      *slog.Logger
	queue    workqueue.TypedRateLimitingInterface[string]
	informer cache.SharedIndexInformer
	// This release's scan Pods; their count is the concurrency in use.
	podStore cache.Store
	// Wakes the dispatcher when a slot may have freed or work arrived.
	wakeup    chan struct{}
	mu        sync.Mutex
	ready     atomic.Bool
	artifacts sync.Mutex
	// Only bounded severity counts, never full SBOMs, survive parsing.
	summaries sync.Map // artifact key -> vulnerabilitySummary
}

func (c *Controller) Run(ctx context.Context) error {
	if c.Config.MaxBytes < 32<<20 || c.Config.PriorityClass == "" {
		return errors.New("invalid scan priority class or cache size")
	}
	if err := os.MkdirAll(c.Config.CacheDir, 0700); err != nil {
		return err
	}
	defer c.ready.Store(false)
	c.queue = workqueue.NewTypedRateLimitingQueue(workqueue.DefaultTypedControllerRateLimiter[string]())
	defer c.queue.ShutDown()
	c.informer = dynamicinformer.NewFilteredDynamicInformer(c.Dynamic, images, "", 30*time.Minute, cache.Indexers{}, nil).Informer()
	c.wakeup = make(chan struct{}, 1)
	enqueue := func(obj any) {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			c.queue.Add(u.GetName())
		}
	}
	_, err := c.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: func(obj any) { enqueue(obj); c.wake() }, UpdateFunc: func(_, obj any) { enqueue(obj) }})
	if err != nil {
		return err
	}
	factory := informers.NewSharedInformerFactoryWithOptions(c.Kube, 0, informers.WithNamespace(c.Config.Namespace), informers.WithTweakListOptions(func(options *metav1.ListOptions) { options.LabelSelector = "app=" + c.Config.scanServiceAccount() }))
	podEvents := factory.Core().V1().Pods().Informer()
	c.podStore = podEvents.GetStore()
	enqueuePod := func(obj any) {
		if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			obj = tombstone.Obj
		}
		if pod, ok := obj.(*corev1.Pod); ok {
			if name := pod.Annotations["driftmower.io/container-image"]; name != "" {
				c.queue.Add(name)
			}
			// A finished or deleted Pod frees a slot.
			if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed || pod.DeletionTimestamp != nil {
				c.wake()
			}
		}
	}
	if _, err := podEvents.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: enqueuePod, UpdateFunc: func(_, obj any) { enqueuePod(obj) }, DeleteFunc: func(obj any) { enqueuePod(obj); c.wake() }}); err != nil {
		return err
	}
	factory.Start(ctx.Done())
	go c.informer.Run(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), c.informer.HasSynced, podEvents.HasSynced) {
		return ctx.Err()
	}
	c.ready.Store(true)
	go c.reconcileRetention(ctx)
	// Workers only record outcomes; the dispatcher alone starts scans, up to
	// Parallelism at once.
	go c.dispatchLoop(ctx)
	for range 4 {
		go c.worker(ctx)
	}
	<-ctx.Done()
	return ctx.Err()
}
func (c *Controller) worker(ctx context.Context) {
	for {
		name, stop := c.queue.Get()
		if stop {
			return
		}
		err := c.reconcile(ctx, name)
		if err != nil && ctx.Err() == nil {
			c.Log.Warn("scan outcome not recorded", "image", name, "error", err)
			c.queue.AddRateLimited(name)
		} else {
			c.queue.Forget(name)
		}
		c.queue.Done(name)
	}
}

// reconcile attaches finished artifacts and records attempt outcomes for one
// image. Starting scans is the dispatcher's job.
func (c *Controller) reconcile(ctx context.Context, name string) error {
	obj, exists, err := c.informer.GetIndexer().GetByKey(name)
	if err != nil || !exists {
		return err
	}
	image := obj.(*unstructured.Unstructured)
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	var failed error
	for _, raw := range manifests {
		manifest, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		digest, _ := manifest["digest"].(string)
		architecture, _ := manifest["architecture"].(string)
		if digest == "" || architecture == "" {
			continue
		}
		key := Key(digest, c.Config.Image, c.Config.TrivyImage, c.Config.DatabaseImage)
		if _, err := os.Stat(filepath.Join(c.Config.CacheDir, key+".json")); err == nil {
			if err := c.summarizeArtifact(key); err != nil {
				failed = errors.Join(failed, err)
				continue
			}
			// One manifest's failure must not hold back the others.
			if err := c.attach(ctx, name, digest, key); err != nil {
				failed = errors.Join(failed, err)
			}
			continue
		}
		if err := c.observe(ctx, image, digest, key); err != nil {
			failed = errors.Join(failed, err)
		}
	}
	return failed
}

func (c *Controller) attach(ctx context.Context, name, digest, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	image, err := c.Dynamic.Resource(images).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	annotations := map[string]string{"driftmower.io/sbom-" + Key(digest, "manifest")[:40]: key}
	stateAnnotation := c.stateAnnotation(digest)
	if raw := image.GetAnnotations()[stateAnnotation]; raw != "" {
		var state scanState
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return err
		}
		if state.Key == key && len(state.Attempts) > 0 {
			state.Attempts[len(state.Attempts)-1].Outcome = "succeeded"
			state.Attempts[len(state.Attempts)-1].Reason = ""
			encoded, err := json.Marshal(state)
			if err != nil {
				return err
			}
			annotations[stateAnnotation] = string(encoded)
		}
	}
	changed := false
	for annotation, value := range annotations {
		if image.GetAnnotations()[annotation] != value {
			changed = true
		}
	}
	if !changed {
		return nil
	}
	patch, err := json.Marshal(map[string]any{"metadata": map[string]any{"resourceVersion": image.GetResourceVersion(), "annotations": annotations}})
	if err != nil {
		return err
	}
	_, err = c.Dynamic.Resource(images).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

func (c *Controller) authenticated(r *http.Request, account string) (*authv1.TokenReview, error) {
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return nil, errors.New("bearer token required")
	}
	review, err := c.Kube.AuthenticationV1().TokenReviews().Create(r.Context(), &authv1.TokenReview{Spec: authv1.TokenReviewSpec{Token: raw, Audiences: []string{c.Config.Audience}}}, metav1.CreateOptions{})
	if err != nil {
		return nil, err
	}
	if !review.Status.Authenticated || review.Status.User.Username != "system:serviceaccount:"+c.Config.Namespace+":"+account || !slices.Contains(review.Status.Audiences, c.Config.Audience) {
		return nil, errors.New("token rejected")
	}
	return review, nil
}
func (c *Controller) Handler() http.Handler {
	mux := http.NewServeMux()
	metrics := newScanMetrics()
	metrics.registry.MustRegister(&securityCollector{controller: c})
	metrics.registry.MustRegister(&scannerFootprintCollector{controller: c})
	mux.Handle("GET /metrics", promhttp.HandlerFor(metrics.registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !c.ready.Load() {
			http.Error(w, "not leader", 503)
			return
		}
		w.WriteHeader(200)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("PUT /internal/scans/{pod}", func(w http.ResponseWriter, r *http.Request) {
		review, err := c.authenticated(r, c.Config.scanServiceAccount())
		if err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		podNames := review.Status.User.Extra["authentication.kubernetes.io/pod-name"]
		if len(podNames) != 1 {
			http.Error(w, "pod-bound token required", 403)
			return
		}
		pod, err := c.Kube.CoreV1().Pods(c.Config.Namespace).Get(r.Context(), podNames[0], metav1.GetOptions{})
		if err != nil {
			http.Error(w, "pod unavailable", 403)
			return
		}
		if pod.Name != r.PathValue("pod") || pod.Labels["app"] != c.Config.scanServiceAccount() || pod.Spec.ServiceAccountName != c.Config.scanServiceAccount() || pod.DeletionTimestamp != nil || pod.Status.Phase == corev1.PodFailed {
			http.Error(w, "scan token mismatch", 403)
			return
		}
		podUIDs := review.Status.User.Extra["authentication.kubernetes.io/pod-uid"]
		if len(podUIDs) != 1 || podUIDs[0] != string(pod.UID) {
			http.Error(w, "scan token UID mismatch", 403)
			return
		}
		key := pod.Annotations["driftmower.io/artifact-key"]
		if len(key) != 64 || strings.ContainsAny(key, "/\\.") {
			http.Error(w, "invalid key", 400)
			return
		}
		image := pod.Annotations["driftmower.io/container-image"]
		digest := pod.Annotations["driftmower.io/platform-digest"]
		if r.Header.Get("Content-Type") == OversizedSBOMMediaType {
			var report SBOMSizeReport
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
			if decoder.Decode(&report) != nil || decoder.Decode(new(any)) != io.EOF || report.SizeBytes <= MaxSBOMBytes {
				http.Error(w, "invalid oversized SBOM report", 400)
				return
			}
			metrics.size.Observe(float64(report.SizeBytes))
			metrics.oversized.WithLabelValues(image, digest).Set(float64(report.SizeBytes))
			http.Error(w, "artifact too large", 413)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxSBOMBytes))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				// Without a size report the stream's exact total is unknown.
				// Record the observed lower bound, never a fabricated infinity.
				metrics.size.Observe(float64(MaxSBOMBytes + 1))
				metrics.oversized.WithLabelValues(image, digest).Set(float64(MaxSBOMBytes + 1))
			}
			http.Error(w, "artifact too large", 413)
			return
		}
		var bom struct {
			BOMFormat string `json:"bomFormat"`
		}
		if json.Unmarshal(body, &bom) != nil || bom.BOMFormat != "CycloneDX" {
			http.Error(w, "invalid SBOM", 400)
			return
		}
		metrics.size.Observe(float64(len(body)))
		c.artifacts.Lock()
		defer c.artifacts.Unlock()
		if err := c.makeRoom(int64(len(body))); err != nil {
			http.Error(w, "cache full", 507)
			return
		}
		tmp := filepath.Join(c.Config.CacheDir, key+".tmp")
		if err := os.WriteFile(tmp, body, 0600); err != nil {
			http.Error(w, "cache unavailable", 503)
			return
		}
		if err := os.Rename(tmp, filepath.Join(c.Config.CacheDir, key+".json")); err != nil {
			http.Error(w, "cache unavailable", 503)
			return
		}
		metrics.oversized.DeleteLabelValues(image, digest)
		// Rebuild lazily from the persisted artifact, also after a restart.
		c.summaries.Delete(key)
		if c.queue != nil {
			c.queue.Add(image)
		}
		w.WriteHeader(201)
	})
	mux.HandleFunc("GET /v1/sboms/{key}", func(w http.ResponseWriter, r *http.Request) {
		reader := c.Config.ReaderServiceAccount
		if reader == "" {
			reader = "driftmower-mcp"
		}
		if _, err := c.authenticated(r, reader); err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		key := r.PathValue("key")
		if len(key) != 64 || strings.ContainsAny(key, "/\\.") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.cyclonedx+json")
		http.ServeFile(w, r, filepath.Join(c.Config.CacheDir, key+".json"))
	})
	return mux
}
func (c *Controller) makeRoom(incoming int64) error {
	entries, err := os.ReadDir(c.Config.CacheDir)
	if err != nil {
		return err
	}
	type artifact struct {
		name     string
		size     int64
		modified time.Time
	}
	var files []artifact
	total := incoming
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			info, err := e.Info()
			if err != nil {
				return err
			}
			files = append(files, artifact{e.Name(), info.Size(), info.ModTime()})
			total += info.Size()
		}
	}
	slices.SortFunc(files, func(a, b artifact) int { return a.modified.Compare(b.modified) })
	for _, file := range files {
		if total <= c.Config.MaxBytes {
			break
		}
		if err := os.Remove(filepath.Join(c.Config.CacheDir, file.name)); err != nil {
			return err
		}
		c.summaries.Delete(strings.TrimSuffix(file.name, ".json"))
		total -= file.size
	}
	if total > c.Config.MaxBytes {
		return fmt.Errorf("artifact exceeds cache limit")
	}
	return nil
}

// Preserve containerd's recorded immutable reference: pulling an index does
// not necessarily register a repository@platform-manifest alias.
func cachedReference(references []string, manifests []any, architecture, digest string) (string, error) {
	for _, ref := range references {
		if strings.HasSuffix(ref, "@"+digest) {
			return ref, nil
		}
	}
	matches := 0
	for _, raw := range manifests {
		if m, ok := raw.(map[string]any); ok && m["architecture"] == architecture {
			matches++
		}
	}
	if matches != 1 {
		return "", errors.New("cached index has ambiguous platform manifests")
	}
	for _, ref := range references {
		if strings.Contains(ref, "@sha256:") {
			return ref, nil
		}
	}
	return "", errors.New("no immutable cached image reference")
}
