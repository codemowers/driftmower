package scanner

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

const (
	maxScanAttempts = 5
	// The dispatcher also wakes on scan Pod events; the tick covers missed
	// events and attempts that time out without one.
	dispatchInterval = 30 * time.Second
	defaultParallel  = 2
)

type scanAttempt struct {
	Pod       string `json:"pod"`
	Node      string `json:"node"`
	Hostname  string `json:"hostname"`
	Reference string `json:"reference"`
	Outcome   string `json:"outcome,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// Bounded per-platform history survives operator restarts and diagnostic Pod
// cleanup. A new scanner/database version gets a fresh artifact and budget.
type scanState struct {
	Key        string        `json:"key"`
	Generation int           `json:"generation,omitempty"`
	Attempts   []scanAttempt `json:"attempts"`
}

func (s scanState) inFlight() bool {
	return len(s.Attempts) > 0 && s.Attempts[len(s.Attempts)-1].Outcome == ""
}

func (c *Controller) stateAnnotation(digest string) string {
	return "driftmower.io/scan-" + Key(digest, c.Config.Instance)[:40]
}

func (c *Controller) loadState(image *unstructured.Unstructured, digest, key string) (scanState, error) {
	state := scanState{Key: key}
	if raw := image.GetAnnotations()[c.stateAnnotation(digest)]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return scanState{}, fmt.Errorf("invalid persisted scan attempts: %w", err)
		}
		if state.Key != key {
			state = scanState{Key: key}
		}
	}
	return state, nil
}

func (c *Controller) saveScanState(ctx context.Context, image *unstructured.Unstructured, digest string, state scanState) error {
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	patch, err := json.Marshal(map[string]any{"metadata": map[string]any{
		"resourceVersion": image.GetResourceVersion(),
		"annotations":     map[string]string{c.stateAnnotation(digest): string(encoded)},
	}})
	if err != nil {
		return err
	}
	updated, err := c.Dynamic.Resource(images).Patch(ctx, image.GetName(), types.MergePatchType, patch, metav1.PatchOptions{})
	if err == nil {
		image.Object = updated.Object
	}
	return err
}

func (c *Controller) artifactExists(key string) (bool, error) {
	_, err := os.Stat(filepath.Join(c.Config.CacheDir, key+".json"))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// restartIfEvicted starts a fresh scan cycle for a successful artifact the
// cache has since evicted. It reports whether state changed.
func (c *Controller) restartIfEvicted(state *scanState) (bool, error) {
	if len(state.Attempts) == 0 || state.Attempts[len(state.Attempts)-1].Outcome != "succeeded" {
		return false, nil
	}
	if exists, err := c.artifactExists(state.Key); err != nil || exists {
		return false, err
	}
	state.Attempts = nil
	state.Generation++
	return true, nil
}

// observe records the outcome of the latest attempt and ends attempts that
// cannot finish. It never starts a scan; the dispatcher does.
func (c *Controller) observe(ctx context.Context, recorded *unstructured.Unstructured, digest, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Read the durable state rather than an informer snapshot that may predate
	// the last recorded attempt.
	image, err := c.Dynamic.Resource(images).Get(ctx, recorded.GetName(), metav1.GetOptions{})
	if err != nil {
		return err
	}
	state, err := c.loadState(image, digest, key)
	if err != nil {
		return err
	}
	if changed, err := c.restartIfEvicted(&state); err != nil {
		return err
	} else if changed {
		return c.saveScanState(ctx, image, digest, state)
	}
	if !state.inFlight() {
		return nil
	}
	last := &state.Attempts[len(state.Attempts)-1]
	pods := c.Kube.CoreV1().Pods(c.Config.Namespace)
	// client-go returns an empty, non-nil Pod alongside NotFound.
	pod, err := pods.Get(ctx, last.Pod, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		pod = nil
	} else if err != nil {
		return err
	}
	if pod != nil && !ownsScanPod(pod, image, key, c.Config.scanServiceAccount()) {
		return errors.New("scan Pod identity mismatch")
	}
	switch {
	case pod == nil:
		last.Outcome, last.Reason = "failed", "scan Pod disappeared"
	case pod.Status.Phase == corev1.PodFailed:
		last.Outcome, last.Reason = "failed", pod.Status.Reason
	case pod.Status.Phase == corev1.PodSucceeded:
		if exists, err := c.artifactExists(key); err != nil {
			return err
		} else if exists {
			last.Outcome = "succeeded"
		} else {
			last.Outcome, last.Reason = "failed", "scan completed without an artifact"
		}
	default:
		if last.Reason = scanPodFailure(pod); last.Reason == "" {
			return nil
		}
		last.Outcome = "failed"
	}
	if err := c.saveScanState(ctx, image, digest, state); err != nil {
		return err
	}
	// Image volume failures do not make a Pod terminal. End the attempt
	// ourselves, after recording it, so it frees its slot.
	if pod != nil && last.Outcome == "failed" && pod.Status.Phase != corev1.PodFailed && pod.Status.Phase != corev1.PodSucceeded && pod.DeletionTimestamp == nil {
		if err := pods.Delete(ctx, pod.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &pod.UID}}); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	c.wake()
	return nil
}

// pendingScan is one platform manifest that needs a scan attempt.
type pendingScan struct {
	image        *unstructured.Unstructured
	digest, arch string
	key          string
	attempts     int
}

// pendingScans lists manifests without an artifact, an in-flight attempt or
// an exhausted budget, from the informer cache.
func (c *Controller) pendingScans() []pendingScan {
	var out []pendingScan
	for _, obj := range c.informer.GetStore().List() {
		image, ok := obj.(*unstructured.Unstructured)
		if !ok || image.GetDeletionTimestamp() != nil {
			continue
		}
		manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
		for _, raw := range manifests {
			manifest, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			digest, _ := manifest["digest"].(string)
			arch, _ := manifest["architecture"].(string)
			if digest == "" || arch == "" {
				continue
			}
			key := Key(digest, c.Config.Image, c.Config.TrivyImage, c.Config.DatabaseImage)
			if exists, err := c.artifactExists(key); err != nil || exists {
				continue
			}
			state, err := c.loadState(image, digest, key)
			if err != nil {
				continue
			}
			if _, err := c.restartIfEvicted(&state); err != nil {
				continue
			}
			if state.inFlight() || len(state.Attempts) >= maxScanAttempts {
				continue
			}
			out = append(out, pendingScan{image: image, digest: digest, arch: arch, key: key, attempts: len(state.Attempts)})
		}
	}
	return out
}

// order shuffles pending scans, fewest attempts first, so repeatedly failing
// images sink behind fresh ones instead of blocking them.
func order(pending []pendingScan) {
	rand.Shuffle(len(pending), func(i, j int) { pending[i], pending[j] = pending[j], pending[i] })
	slices.SortStableFunc(pending, func(a, b pendingScan) int { return cmp.Compare(a.attempts, b.attempts) })
}

func (c *Controller) parallelism() int {
	if c.Config.Parallelism > 0 {
		return c.Config.Parallelism
	}
	return defaultParallel
}

// activeScans counts this release's scan Pods that still hold a slot.
func (c *Controller) activeScans() int {
	n := 0
	for _, obj := range c.podStore.List() {
		if pod, ok := obj.(*corev1.Pod); ok && pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed {
			n++
		}
	}
	return n
}

func (c *Controller) wake() {
	if c.wakeup == nil {
		return
	}
	select {
	case c.wakeup <- struct{}{}:
	default:
	}
}

// dispatchLoop keeps up to parallelism scans running.
func (c *Controller) dispatchLoop(ctx context.Context) {
	ticker := time.NewTicker(dispatchInterval)
	defer ticker.Stop()
	for {
		c.fill(ctx)
		select {
		case <-ctx.Done():
			return
		case <-c.wakeup:
		case <-ticker.C:
			// Re-observe running attempts, which may time out without an
			// event.
			for _, obj := range c.podStore.List() {
				if pod, ok := obj.(*corev1.Pod); ok {
					if name := pod.Annotations["driftmower.io/container-image"]; name != "" {
						c.queue.Add(name)
					}
				}
			}
		}
	}
}

// fill starts scans for random pending manifests until every slot is used.
func (c *Controller) fill(ctx context.Context) {
	free := c.parallelism() - c.activeScans()
	if free <= 0 {
		return
	}
	pending := c.pendingScans()
	if len(pending) == 0 {
		return
	}
	order(pending)
	nodes, err := c.Kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.Log.Warn("scan dispatch: list nodes", "error", err)
		return
	}
	for _, p := range pending {
		if free == 0 || ctx.Err() != nil {
			return
		}
		started, err := c.start(ctx, p, nodes.Items)
		if err != nil {
			c.Log.Warn("scan not started", "image", p.image.GetName(), "digest", p.digest, "error", err)
		}
		if started {
			free--
		}
	}
}

// start creates the next attempt's Pod and then records it. Pod names are
// deterministic, so a Pod whose record was lost is adopted, not duplicated.
func (c *Controller) start(ctx context.Context, p pendingScan, nodes []corev1.Node) (bool, error) {
	// Choose from the cached snapshot first: most pending manifests have no
	// eligible Node, and that must not cost an API read per round.
	state, err := c.loadState(p.image, p.digest, p.key)
	if err != nil {
		return false, err
	}
	if _, err := c.restartIfEvicted(&state); err != nil {
		return false, err
	}
	if _, ok := c.nextNode(p.image, state, nodes, p.arch, p.digest, p.key); !ok {
		return false, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	image, err := c.Dynamic.Resource(images).Get(ctx, p.image.GetName(), metav1.GetOptions{})
	if err != nil {
		return false, err
	}
	if state, err = c.loadState(image, p.digest, p.key); err != nil {
		return false, err
	}
	if _, err := c.restartIfEvicted(&state); err != nil {
		return false, err
	}
	if exists, err := c.artifactExists(p.key); err != nil || exists || state.inFlight() || len(state.Attempts) >= maxScanAttempts {
		return false, err
	}
	attempt, ok := c.nextNode(image, state, nodes, p.arch, p.digest, p.key)
	if !ok {
		return false, nil
	}
	attempt.Pod = fmt.Sprintf("scan-%s-%d-%d", Key(p.key, image.GetName(), c.Config.Instance)[:40], state.Generation, len(state.Attempts)+1)
	pods := c.Kube.CoreV1().Pods(c.Config.Namespace)
	pod := ScanPod(c.Config, p.key, image.GetName(), string(image.GetUID()), attempt.Reference, attempt.Hostname, p.arch, attempt.Pod)
	pod.Annotations["driftmower.io/platform-digest"] = p.digest
	if _, err := pods.Create(ctx, pod, metav1.CreateOptions{}); apierrors.IsAlreadyExists(err) {
		existing, err := pods.Get(ctx, attempt.Pod, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		if !ownsScanPod(existing, image, p.key, c.Config.scanServiceAccount()) {
			return false, errors.New("scan Pod identity mismatch")
		}
		attempt = adoptedAttempt(existing, nodes)
	} else if err != nil {
		return false, err
	}
	state.Attempts = append(state.Attempts, attempt)
	// If this fails, the Pod runs unrecorded until the next round adopts it.
	return true, c.saveScanState(ctx, image, p.digest, state)
}

// nextNode picks the Node for the next attempt, or reports none.
//
// Node.status.images is capped by the kubelet (nodeStatusMaxImages, 50
// largest by default), so most images never appear there. Nodes that report
// the image come first, then nodes ContainerImage.nodes says pulled it: in use
// before unused, which garbage collection may have removed. Each attempt
// takes a different Node, up to maxScanAttempts.
func (c *Controller) nextNode(image *unstructured.Unstructured, state scanState, nodes []corev1.Node, architecture, digest, key string) (scanAttempt, bool) {
	references, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	reference, err := cachedReference(references, manifests, architecture, digest)
	if err != nil {
		return scanAttempt{}, false
	}
	options := []string{reference}
	for _, alias := range references {
		if _, err := cachedReference([]string{alias}, manifests, architecture, digest); err == nil && !slices.Contains(options, alias) {
			options = append(options, alias)
		}
	}
	hostCounts := map[string]int{}
	for _, node := range nodes {
		hostCounts[node.Labels["kubernetes.io/hostname"]]++
	}
	inventory := inventoryNodes(image)
	type candidate struct {
		node *corev1.Node
		ref  string
		tier int
	}
	var candidates []candidate
	for i := range nodes {
		node := &nodes[i]
		host := node.Labels["kubernetes.io/hostname"]
		if node.Spec.Unschedulable || node.Labels["kubernetes.io/arch"] != architecture || host == "" || hostCounts[host] != 1 ||
			!slices.ContainsFunc(node.Status.Conditions, func(cond corev1.NodeCondition) bool {
				return cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue
			}) ||
			slices.ContainsFunc(state.Attempts, func(a scanAttempt) bool { return a.Node == node.Name }) {
			continue
		}
		if i := slices.IndexFunc(options, func(ref string) bool {
			return slices.ContainsFunc(node.Status.Images, func(img corev1.ContainerImage) bool { return slices.Contains(img.Names, ref) })
		}); i >= 0 {
			candidates = append(candidates, candidate{node: node, ref: options[i], tier: 0})
		} else if unused, ok := inventory[node.Name]; ok {
			tier := 1
			if unused {
				tier = 2
			}
			candidates = append(candidates, candidate{node: node, ref: reference, tier: tier})
		}
	}
	if len(candidates) == 0 {
		return scanAttempt{}, false
	}
	// Stable, distributed selection within a tier.
	next := slices.MinFunc(candidates, func(a, b candidate) int {
		return cmp.Or(cmp.Compare(a.tier, b.tier), cmp.Compare(Key(key, a.node.Name), Key(key, b.node.Name)))
	})
	return scanAttempt{Node: next.node.Name, Hostname: next.node.Labels["kubernetes.io/hostname"], Reference: next.ref}, true
}

// adoptedAttempt reconstructs the record of an existing attempt Pod.
func adoptedAttempt(pod *corev1.Pod, nodes []corev1.Node) scanAttempt {
	attempt := scanAttempt{Pod: pod.Name, Hostname: pod.Spec.NodeSelector["kubernetes.io/hostname"], Node: pod.Spec.NodeName}
	for _, node := range nodes {
		if attempt.Node == "" && node.Labels["kubernetes.io/hostname"] == attempt.Hostname {
			attempt.Node = node.Name
		}
	}
	for _, volume := range pod.Spec.Volumes {
		if volume.Name == "target" && volume.Image != nil {
			attempt.Reference = volume.Image.Reference
		}
	}
	return attempt
}

// inventoryNodes maps the Nodes ContainerImage.nodes says pulled the image to
// whether it is marked unused there.
func inventoryNodes(image *unstructured.Unstructured) map[string]bool {
	out := map[string]bool{}
	entries, _, _ := unstructured.NestedSlice(image.Object, "nodes")
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := entry["name"].(string)
		unused, _ := entry["unused"].(bool)
		if name != "" {
			out[name] = unused
		}
	}
	return out
}

func ownsScanPod(pod *corev1.Pod, image *unstructured.Unstructured, key, account string) bool {
	return pod.Labels["app"] == account && pod.Annotations["driftmower.io/artifact-key"] == key &&
		slices.ContainsFunc(pod.OwnerReferences, func(owner metav1.OwnerReference) bool {
			return owner.APIVersion == "codemowers.io/v1alpha1" && owner.Kind == "ContainerImage" && owner.UID == image.GetUID()
		})
}

func scanPodFailure(pod *corev1.Pod) string {
	for _, status := range append(slices.Clone(pod.Status.InitContainerStatuses), pod.Status.ContainerStatuses...) {
		if status.State.Waiting != nil && status.State.Waiting.Reason == "ErrImageNeverPull" {
			return status.State.Waiting.Reason
		}
	}
	if !pod.CreationTimestamp.IsZero() && time.Since(pod.CreationTimestamp.Time) > 15*time.Minute {
		return "scan attempt exceeded 15 minutes"
	}
	return ""
}
