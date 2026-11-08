package scanner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

	authv1 "k8s.io/api/authentication/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
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
	Config      Config
	Kube        kubernetes.Interface
	Dynamic     dynamic.Interface
	Log         *slog.Logger
	queue       workqueue.TypedRateLimitingInterface[string]
	informer    cache.SharedIndexInformer
	mu          sync.Mutex
	ready       atomic.Bool
	artifacts   sync.Mutex
	unavailable map[string]time.Time
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
	enqueue := func(obj any) {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			c.queue.Add(u.GetName())
		}
	}
	_, err := c.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: enqueue, UpdateFunc: func(_, obj any) { enqueue(obj) }})
	if err != nil {
		return err
	}
	factory := informers.NewSharedInformerFactoryWithOptions(c.Kube, 0, informers.WithNamespace(c.Config.Namespace), informers.WithTweakListOptions(func(options *metav1.ListOptions) { options.LabelSelector = "app=driftmower-scan" }))
	jobEvents := factory.Batch().V1().Jobs().Informer()
	podEvents := factory.Core().V1().Pods().Informer()
	enqueueJob := func(obj any) {
		if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			obj = tombstone.Obj
		}
		if job, ok := obj.(*batchv1.Job); ok {
			for _, owner := range job.OwnerReferences {
				if owner.Kind == "ContainerImage" && owner.APIVersion == "codemowers.io/v1alpha1" {
					c.queue.Add(owner.Name)
				}
			}
		}
	}
	enqueuePod := func(obj any) {
		if pod, ok := obj.(*corev1.Pod); ok {
			if name := pod.Annotations["driftmower.io/container-image"]; name != "" {
				c.queue.Add(name)
			}
		}
	}
	if _, err := jobEvents.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: enqueueJob, UpdateFunc: func(_, obj any) { enqueueJob(obj) }, DeleteFunc: enqueueJob}); err != nil {
		return err
	}
	if _, err := podEvents.AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: enqueuePod, UpdateFunc: func(_, obj any) { enqueuePod(obj) }}); err != nil {
		return err
	}
	factory.Start(ctx.Done())
	go c.informer.Run(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), c.informer.HasSynced, jobEvents.HasSynced, podEvents.HasSynced) {
		return ctx.Err()
	}
	c.ready.Store(true)
	go c.reconcileRetention(ctx)
	// Reconciliation workers do not wait for scans. Quota controls Pod admission.
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
			c.Log.Warn("scan deferred", "image", name, "error", err)
			c.queue.AddRateLimited(name)
		} else {
			c.queue.Forget(name)
		}
		c.queue.Done(name)
	}
}
func (c *Controller) reconcile(ctx context.Context, name string) error {
	obj, exists, err := c.informer.GetIndexer().GetByKey(name)
	if err != nil || !exists {
		return err
	}
	image := obj.(*unstructured.Unstructured)
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	references, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
	if len(references) == 0 {
		return errors.New("no cached digest reference")
	}
	candidates, _, _ := unstructured.NestedSlice(image.Object, "nodes")
	var deferred error
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
			if err := c.attach(ctx, name, digest, key); err != nil {
				return err
			}
			continue
		}
		reference, err := cachedReference(references, manifests, architecture, digest)
		if err != nil {
			return err
		}
		jobName := JobName(name, digest)
		if err := c.dispatch(ctx, image, candidates, architecture, digest, reference, key); err != nil {
			deferred = errors.Join(deferred, err)
			continue
		}
		job, err := c.Kube.BatchV1().Jobs(c.Config.Namespace).Get(ctx, jobName, metav1.GetOptions{})
		if err != nil {
			deferred = errors.Join(deferred, err)
			continue
		}
		if !finished(job) {
			if err := c.releaseMissingImage(ctx, job, key); err != nil {
				deferred = errors.Join(deferred, err)
			}
		} else if job.Status.Succeeded > 0 {
			if _, err := os.Stat(filepath.Join(c.Config.CacheDir, key+".json")); err == nil {
				if err := c.attach(ctx, name, digest, key); err != nil {
					deferred = errors.Join(deferred, err)
				}
			}
		}
	}
	return deferred
}

func (c *Controller) attach(ctx context.Context, name, digest, key string) error {
	// One bounded reference per platform digest, not one per architecture:
	// multiple variants can share an architecture. Full SBOMs stay off etcd.
	suffix := Key(digest, "manifest")[:40]
	annotation, _ := json.Marshal(map[string]any{"metadata": map[string]any{"annotations": map[string]string{"driftmower.io/sbom-" + suffix: key}}})
	_, err := c.Dynamic.Resource(images).Patch(ctx, name, types.MergePatchType, annotation, metav1.PatchOptions{})
	return err
}

// Serialize same-name reconciliation; Kubernetes quota controls Pod admission.
func (c *Controller) dispatch(ctx context.Context, image *unstructured.Unstructured, candidates []any, architecture, digest, reference, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	jobs := c.Kube.BatchV1().Jobs(c.Config.Namespace)
	name := JobName(image.GetName(), digest)
	existing, err := jobs.Get(ctx, name, metav1.GetOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if apierrors.IsNotFound(err) {
		existing = nil
	}
	if existing != nil && existing.DeletionTimestamp != nil {
		return errors.New("waiting for previous Job deletion")
	}
	nodes, err := c.Kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	byName := map[string]*corev1.Node{}
	hostCounts := map[string]int{}
	for i := range nodes.Items {
		node := &nodes.Items[i]
		byName[node.Name] = node
		hostCounts[node.Labels["kubernetes.io/hostname"]]++
	}
	aliases, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	options := []string{reference}
	for _, alias := range aliases {
		if _, err := cachedReference([]string{alias}, manifests, architecture, digest); err == nil && !slices.Contains(options, alias) {
			options = append(options, alias)
		}
	}
	if existing != nil {
		ref := existing.Annotations["driftmower.io/image-reference"]
		if index := slices.Index(options, ref); index > 0 {
			options[0], options[index] = options[index], options[0]
		}
	}
	for _, ref := range options {
		var hosts []string
		for _, raw := range candidates {
			candidate, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			nodeName, _ := candidate["name"].(string)
			node := byName[nodeName]
			if node == nil || node.Spec.Unschedulable || node.Labels["kubernetes.io/arch"] != architecture {
				continue
			}
			host := node.Labels["kubernetes.io/hostname"]
			if host == "" || hostCounts[host] != 1 || time.Now().Before(c.unavailable[key+"|"+host+"|"+ref]) {
				continue
			}
			if !slices.ContainsFunc(node.Status.Conditions, func(condition corev1.NodeCondition) bool {
				return condition.Type == corev1.NodeReady && condition.Status == corev1.ConditionTrue
			}) {
				continue
			}
			hosts = append(hosts, host)
		}
		if len(hosts) == 0 {
			continue
		}
		job := ScanJobForNodes(c.Config, key, image.GetName(), string(image.GetUID()), ref, architecture, name, hosts)
		job.Annotations["driftmower.io/pod-spec-hash"] = podSpecHash(job)
		job.Annotations["driftmower.io/image-digest"] = digest
		job.Annotations["driftmower.io/database-image"] = c.Config.DatabaseImage
		job.Annotations["driftmower.io/scanner-image"] = c.Config.TrivyImage
		job.Annotations["driftmower.io/image-reference"] = ref
		if existing != nil {
			// Admission defaults are not desired-spec changes. Compare the fingerprint
			// recorded before admission, not server-defaulted Pod fields.
			if existing.Annotations["driftmower.io/pod-spec-hash"] == job.Annotations["driftmower.io/pod-spec-hash"] {
				return nil
			}
			propagation := metav1.DeletePropagationForeground
			if err := jobs.Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &propagation}); err != nil {
				return err
			}
			return errors.New("Pod spec changed; waiting for Job replacement")
		}
		_, err = jobs.Create(ctx, job, metav1.CreateOptions{})
		return err
	}
	return errors.New("no usable cached-image node")
}

func finished(job *batchv1.Job) bool {
	return slices.ContainsFunc(job.Status.Conditions, func(c batchv1.JobCondition) bool {
		return c.Status == corev1.ConditionTrue && (c.Type == batchv1.JobComplete || c.Type == batchv1.JobFailed)
	})
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
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !c.ready.Load() {
			http.Error(w, "not leader", 503)
			return
		}
		w.WriteHeader(200)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("PUT /internal/scans/{job}", func(w http.ResponseWriter, r *http.Request) {
		review, err := c.authenticated(r, "driftmower-scan")
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
		job, err := c.Kube.BatchV1().Jobs(c.Config.Namespace).Get(r.Context(), r.PathValue("job"), metav1.GetOptions{})
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if !slices.ContainsFunc(pod.OwnerReferences, func(ref metav1.OwnerReference) bool { return ref.Kind == "Job" && ref.UID == job.UID }) {
			http.Error(w, "job token mismatch", 403)
			return
		}
		key := job.Annotations["driftmower.io/artifact-key"]
		if len(key) != 64 || strings.ContainsAny(key, "/\\.") {
			http.Error(w, "invalid key", 400)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
		if err != nil {
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
		w.WriteHeader(201)
	})
	mux.HandleFunc("GET /v1/sboms/{key}", func(w http.ResponseWriter, r *http.Request) {
		if _, err := c.authenticated(r, "driftmower-mcp"); err != nil {
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

// Cache misses cannot recover with Never. Release the slot and temporarily
// exclude this node/reference pair while other images continue through the queue.
func (c *Controller) releaseMissingImage(ctx context.Context, job *batchv1.Job, key string) error {
	pods, err := c.Kube.CoreV1().Pods(c.Config.Namespace).List(ctx, metav1.ListOptions{LabelSelector: "batch.kubernetes.io/job-name=" + job.Name})
	if err != nil {
		return err
	}
	for _, pod := range pods.Items {
		if !slices.ContainsFunc(pod.OwnerReferences, func(owner metav1.OwnerReference) bool { return owner.UID == job.UID && owner.Kind == "Job" }) {
			continue
		}
		statuses := append(slices.Clone(pod.Status.InitContainerStatuses), pod.Status.ContainerStatuses...)
		for _, status := range statuses {
			if status.State.Waiting == nil || status.State.Waiting.Reason != "ErrImageNeverPull" {
				continue
			}
			host := job.Spec.Template.Spec.NodeSelector["kubernetes.io/hostname"]
			if pod.Spec.NodeName != "" {
				node, err := c.Kube.CoreV1().Nodes().Get(ctx, pod.Spec.NodeName, metav1.GetOptions{})
				if err != nil {
					return err
				}
				host = node.Labels["kubernetes.io/hostname"]
			}
			if host == "" {
				return errors.New("cannot identify cache-miss node")
			}
			reference := job.Annotations["driftmower.io/image-reference"]
			c.mu.Lock()
			if c.unavailable == nil {
				c.unavailable = map[string]time.Time{}
			}
			for entry, until := range c.unavailable {
				if time.Now().After(until) {
					delete(c.unavailable, entry)
				}
			}
			c.unavailable[key+"|"+host+"|"+reference] = time.Now().Add(10 * time.Minute)
			c.mu.Unlock()
			// A pending image-volume cache miss never triggers native backoff.
			// End this attempt so it releases capacity; keep the failed Job
			// unless choosing another node/reference requires replacement.
			if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 1 {
				_, err := c.Kube.BatchV1().Jobs(c.Config.Namespace).Patch(ctx, job.Name, types.MergePatchType, []byte(`{"spec":{"activeDeadlineSeconds":1,"ttlSecondsAfterFinished":172800}}`), metav1.PatchOptions{})
				if err != nil {
					return err
				}
			}
			return errors.New("recorded image cache entry missing; retrying another node or reference")
		}
	}
	return nil
}

func podSpecHash(job *batchv1.Job) string {
	body, _ := json.Marshal(job.Spec.Template.Spec)
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
