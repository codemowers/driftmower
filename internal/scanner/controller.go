package scanner

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/codemowers/driftmower/internal/imageanalysis"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/codemowers/driftmower/internal/platformapis"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
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
	wakeup         chan struct{}
	mu             sync.Mutex
	ready          atomic.Bool
	disabled       atomic.Bool
	dispatchHalted atomic.Bool
	artifacts      sync.Mutex
	// Only bounded severity counts, never full SBOMs, survive parsing.
	summaries sync.Map // artifact key -> vulnerabilitySummary
}

func (c *Controller) Run(ctx context.Context) error {
	installed, err := platformapis.HasResources(c.Kube.Discovery(), "codemowers.io/v1alpha1", "containerimages", "sourcerepositories")
	if err != nil {
		return err
	}
	if !installed {
		c.Log.Warn("nodestatd is not installed: ContainerImage or SourceRepository CRD is missing; Trivy scanner dispatching is disabled", "install", platformapis.NodestatdInstall, "k3s", "add --set containerd.socket=/run/k3s/containerd/containerd.sock; restart Driftmower after installing")
		c.disabled.Store(true)
		c.ready.Store(true)
		defer c.ready.Store(false)
		<-ctx.Done()
		return ctx.Err()
	}

	if c.Config.Strategy != "" && c.Config.Strategy != StrategyOperatorNamespace && c.Config.Strategy != StrategyWorkloadNamespace {
		return fmt.Errorf("unknown scan strategy %q", c.Config.Strategy)
	}
	if c.Config.CPURequest != "" {
		cpu, err := resource.ParseQuantity(c.Config.CPURequest)
		if err != nil || cpu.Sign() <= 0 {
			return errors.New("scan CPU request must be a positive quantity")
		}
	}
	if c.Config.MaxBytes < 32<<20 || c.Config.PriorityClass == "" {
		return errors.New("invalid scan priority class or cache size")
	}
	if err := os.MkdirAll(c.Config.CacheDir, 0700); err != nil {
		return err
	}
	c.artifacts.Lock()
	if err := c.cleanupLegacy(); err != nil {
		c.artifacts.Unlock()
		return err
	}
	if err := c.makeRoom(0); err != nil {
		c.artifacts.Unlock()
		return err
	}
	c.artifacts.Unlock()
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
	_, err = c.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: func(obj any) { enqueue(obj); c.wake() }, UpdateFunc: func(_, obj any) { enqueue(obj) }})
	if err != nil {
		return err
	}
	factory := informers.NewSharedInformerFactoryWithOptions(c.Kube, 0, informers.WithNamespace(c.scanNamespace()), informers.WithTweakListOptions(func(options *metav1.ListOptions) { options.LabelSelector = "app=" + c.Config.scanServiceAccount() }))
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
		key := c.Config.artifactKey(digest)
		if available, err := c.artifactExists(key); err != nil {
			failed = errors.Join(failed, err)
			continue
		} else if available {
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
			state.Digest = digest
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

func (c *Controller) reviewToken(r *http.Request) (*authv1.TokenReview, error) {
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return nil, errors.New("bearer token required")
	}
	review, err := c.Kube.AuthenticationV1().TokenReviews().Create(r.Context(), &authv1.TokenReview{Spec: authv1.TokenReviewSpec{Token: raw, Audiences: []string{c.Config.Audience}}}, metav1.CreateOptions{})
	if err != nil {
		return nil, err
	}
	if !review.Status.Authenticated || !slices.Contains(review.Status.Audiences, c.Config.Audience) {
		return nil, errors.New("token rejected")
	}
	return review, nil
}
func (c *Controller) authenticated(r *http.Request, account string) (*authv1.TokenReview, error) {
	review, err := c.reviewToken(r)
	if err != nil {
		return nil, err
	}
	if review.Status.User.Username != "system:serviceaccount:"+c.Config.Namespace+":"+account {
		return nil, errors.New("token rejected")
	}
	return review, nil
}

func (c *Controller) Handler() http.Handler {
	mux := http.NewServeMux()
	metrics := newScanMetrics()
	metrics.registry.MustRegister(&securityCollector{controller: c})
	metrics.registry.MustRegister(&scannerFootprintCollector{controller: c})
	metrics.registry.MustRegister(&scanDispatchCollector{controller: c})
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
		review, err := c.reviewToken(r)
		if err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		identity := strings.Split(review.Status.User.Username, ":")
		if len(identity) != 4 || identity[0] != "system" || identity[1] != "serviceaccount" || identity[3] != c.Config.scanServiceAccount() || (c.Config.Strategy != StrategyWorkloadNamespace && identity[2] != c.Config.Namespace) {
			http.Error(w, "unauthorized", 401)
			return
		}
		podNames := review.Status.User.Extra["authentication.kubernetes.io/pod-name"]
		if len(podNames) != 1 {
			http.Error(w, "pod-bound token required", 403)
			return
		}
		pod, err := c.Kube.CoreV1().Pods(identity[2]).Get(r.Context(), podNames[0], metav1.GetOptions{})
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
		if c.Config.Strategy == StrategyWorkloadNamespace {
			imageObj, err := c.Dynamic.Resource(images).Get(r.Context(), image, metav1.GetOptions{})
			if err != nil {
				http.Error(w, "image unavailable", 503)
				return
			}
			if !ownsScanPod(pod, imageObj, key, c.Config.scanServiceAccount()) {
				http.Error(w, "image ownership mismatch", 403)
				return
			}
			state, err := c.loadState(imageObj, digest, key)
			if err != nil {
				http.Error(w, "scan state unavailable", 503)
				return
			}
			if !slices.ContainsFunc(state.Attempts, func(a scanAttempt) bool {
				return a.Pod == pod.Name && c.attemptNamespace(a) == pod.Namespace && a.UID == pod.UID && a.UID != ""
			}) {
				http.Error(w, "scan attempt not recorded", 503)
				return
			}
		}
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
		if r.Header.Get("Content-Encoding") != "gzip" {
			http.Error(w, "gzip SBOM upload required", http.StatusUnsupportedMediaType)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxCompressedSBOMBytes))
		if err != nil {
			http.Error(w, "compressed artifact too large", http.StatusRequestEntityTooLarge)
			return
		}
		size, err := validateCompressedSBOM(bytes.NewReader(body))
		if size > MaxSBOMBytes {
			metrics.size.Observe(float64(size))
			metrics.oversized.WithLabelValues(image, digest).Set(float64(size))
			http.Error(w, "artifact too large", http.StatusRequestEntityTooLarge)
			return
		}
		if err != nil {
			http.Error(w, "invalid gzip SBOM", http.StatusBadRequest)
			return
		}
		reader, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			http.Error(w, "invalid gzip SBOM", 400)
			return
		}
		summary, err := summarizeVulnerabilities(io.LimitReader(reader, MaxSBOMBytes+1))
		reader.Close()
		if err != nil {
			http.Error(w, "invalid SBOM summary", 400)
			return
		}
		if summary.Status != "" && summary.Status != "pending" && summary.Status != "complete" && summary.Status != "failed" {
			http.Error(w, "invalid vulnerability phase", 400)
			return
		}
		pending := summary.Status == "pending" || summary.Status == "failed"
		if pending && !summary.Filesystem {
			http.Error(w, "filesystem evidence required", 400)
			return
		}
		if summary.Filesystem {
			reader, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				http.Error(w, "invalid gzip SBOM", 400)
				return
			}
			_, err = imageanalysis.ReadCycloneDX(io.LimitReader(reader, MaxSBOMBytes+1))
			reader.Close()
			if err != nil {
				http.Error(w, "invalid bounded filesystem evidence", 400)
				return
			}
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		imageObj, err := c.Dynamic.Resource(images).Get(r.Context(), image, metav1.GetOptions{})
		if err != nil {
			http.Error(w, "image unavailable", 503)
			return
		}
		if !ownsScanPod(pod, imageObj, key, c.Config.scanServiceAccount()) {
			http.Error(w, "image ownership mismatch", 403)
			return
		}
		metrics.size.Observe(float64(size))
		c.artifacts.Lock()
		defer c.artifacts.Unlock()
		if pending {
			previous, err := readArtifactSummary(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
			if err == nil && previous.Status != "pending" && previous.Status != "failed" {
				w.WriteHeader(201)
				return
			}
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				http.Error(w, "previous artifact unavailable", 503)
				return
			}
		}
		incoming := int64(len(body))
		if previous, err := os.Stat(filepath.Join(c.Config.CacheDir, key+artifactSuffix)); err == nil {
			incoming -= previous.Size()
		} else if !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "previous artifact unavailable", 503)
			return
		}
		if err := c.makeRoomFor(incoming, key); err != nil {
			http.Error(w, "cache full", 507)
			return
		}
		tmp := filepath.Join(c.Config.CacheDir, key+".tmp")
		if err := os.WriteFile(tmp, body, 0600); err != nil {
			http.Error(w, "cache unavailable", 503)
			return
		}
		if err := os.Rename(tmp, filepath.Join(c.Config.CacheDir, key+artifactSuffix)); err != nil {
			http.Error(w, "cache unavailable", 503)
			return
		}
		if !pending {
			metrics.oversized.DeleteLabelValues(image, digest)
		}
		info, err := os.Stat(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
		if err != nil {
			http.Error(w, "artifact unavailable", 503)
			return
		}
		summary.AcceptedAt = float64(info.ModTime().Unix())
		c.summaries.Store(key, summary)
		if summary.Filesystem {
			annotation := "driftmower.io/analysis-" + Key(digest, "manifest")[:40]
			if imageObj.GetAnnotations()[annotation] != key {
				patch, _ := json.Marshal(map[string]any{"metadata": map[string]any{"resourceVersion": imageObj.GetResourceVersion(), "annotations": map[string]string{annotation: key}}})
				if _, err := c.Dynamic.Resource(images).Patch(r.Context(), image, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
					http.Error(w, "filesystem artifact not recorded", 503)
					return
				}
			}
		}
		_ = os.Remove(filepath.Join(c.Config.CacheDir, key+findingsSuffix))
		if c.queue != nil {
			c.queue.Add(image)
		}
		w.WriteHeader(201)
	})
	mux.HandleFunc("POST /v1/findings", func(w http.ResponseWriter, r *http.Request) {
		if _, err := c.authenticated(r, c.Config.readerServiceAccount()); err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		var in struct {
			Keys []string `json:"keys"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil || len(in.Keys) == 0 {
			http.Error(w, "expected artifact keys", 400)
			return
		}
		out := map[string]*ArtifactFindings{}
		for _, key := range in.Keys {
			if len(key) != 64 || strings.Trim(key, "0123456789abcdef") != "" {
				http.Error(w, "invalid artifact key", 400)
				return
			}
			// Missing artifacts are absent from the answer: expired, not clean.
			if findings, err := c.findings(key); err == nil {
				out[key] = findings
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"artifacts": out})
	})
	mux.HandleFunc("POST /v1/packages", c.servePackages)
	mux.HandleFunc("GET /v1/sboms/{key}", func(w http.ResponseWriter, r *http.Request) {
		if _, err := c.authenticated(r, c.Config.readerServiceAccount()); err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		key := r.PathValue("key")
		if len(key) != 64 || strings.ContainsAny(key, "/\\.") {
			http.NotFound(w, r)
			return
		}
		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			http.Error(w, "gzip encoding required", http.StatusNotAcceptable)
			return
		}
		file, err := os.Open(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "artifact unavailable", http.StatusServiceUnavailable)
			return
		}
		defer func() { _ = file.Close() }()
		info, err := file.Stat()
		if err != nil {
			http.Error(w, "artifact unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.cyclonedx+json")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.Header().Set("ETag", fmt.Sprintf(`W/"%x-%x-gzip"`, info.ModTime().UnixNano(), info.Size()))
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Set("Cache-Control", "private, no-cache")
		http.ServeContent(w, r, key+artifactSuffix, info.ModTime(), file)
	})
	mux.HandleFunc("GET /v1/analyses/{key}", c.serveAnalysis)
	return mux
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
