package authz

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
	k8stesting "k8s.io/client-go/testing"
)

var (
	alice    = Identity{User: "issuer#alice", Groups: []string{"system:authenticated", "devs"}}
	bob      = Identity{User: "issuer#bob", Groups: []string{"system:authenticated"}}
	listPods = Attributes{Namespace: "a", Resource: "pods", Verb: "list"}
)

type reviewerFunc func(ctx context.Context, id Identity, attrs Attributes) (bool, error)

func (f reviewerFunc) Allowed(ctx context.Context, id Identity, attrs Attributes) (bool, error) {
	return f(ctx, id, attrs)
}

func TestSubjectAccessReviewer(t *testing.T) {
	cases := []struct {
		status  authorizationv1.SubjectAccessReviewStatus
		allowed bool
		err     error
	}{
		{authorizationv1.SubjectAccessReviewStatus{Allowed: true}, true, nil},
		{authorizationv1.SubjectAccessReviewStatus{Allowed: false}, false, nil},
		{authorizationv1.SubjectAccessReviewStatus{Allowed: true, Denied: true}, false, nil},
		{authorizationv1.SubjectAccessReviewStatus{EvaluationError: "webhook down"}, false, ErrInconclusive},
	}
	for _, tc := range cases {
		client := fake.NewClientset()
		var sent *authorizationv1.SubjectAccessReview
		client.PrependReactor("create", "subjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
			sent = action.(k8stesting.CreateAction).GetObject().(*authorizationv1.SubjectAccessReview)
			out := sent.DeepCopy()
			out.Status = tc.status

			return true, out, nil
		})

		allowed, err := NewSubjectAccessReviewer(client.AuthorizationV1()).Allowed(context.Background(), alice,
			Attributes{Namespace: "a", Verb: "get", Resource: "pods", Subresource: "log", Name: "api"})
		if allowed != tc.allowed || !errors.Is(err, tc.err) {
			t.Errorf("status %+v: Allowed = %v %v", tc.status, allowed, err)
		}
		ra := sent.Spec.ResourceAttributes
		if sent.Spec.User != alice.User || !slices.Equal(sent.Spec.Groups, alice.Groups) ||
			ra.Namespace != "a" || ra.Subresource != "log" || ra.Name != "api" {
			t.Errorf("sent spec = %+v", sent.Spec)
		}
	}
}

func TestCheckerJudgements(t *testing.T) {
	answers := []struct {
		allowed bool
		err     error
	}{
		{true, nil},
		{false, nil},
		{false, ErrInconclusive},
		{false, apierrors.NewForbidden(schema.GroupResource{Group: "authorization.k8s.io", Resource: "subjectaccessreviews"}, "", errors.New("no"))},
		{false, errors.New(strings.Repeat("x", 500))},
	}
	i := 0
	checker := NewChecker(reviewerFunc(func(context.Context, Identity, Attributes) (bool, error) {
		a := answers[i]
		i++

		return a.allowed, a.err
	}))
	create := Attributes{Namespace: "a", Group: "postgresql.cnpg.io", Resource: "clusters", Verb: "create"}
	judge := func() Judgement { return checker.MayPerform(context.Background(), alice, create) }

	if j := judge(); j != (Judgement{Verdict: Yes}) {
		t.Errorf("yes = %+v", j)
	}
	if j := judge(); j != (Judgement{Verdict: No, Reason: "Kubernetes RBAC denies create clusters.postgresql.cnpg.io in namespace a"}) {
		t.Errorf("no = %+v", j)
	}
	if j := judge(); j.Verdict != Unknown || !strings.Contains(j.Reason, "could not be evaluated") {
		t.Errorf("inconclusive = %+v", j)
	}
	if j := judge(); j.Verdict != Unknown || !strings.Contains(j.Reason, "service account may not create SubjectAccessReviews") {
		t.Errorf("forbidden = %+v", j)
	}
	if j := judge(); len([]rune(j.Reason)) > 260 || !strings.HasSuffix(j.Reason, "…") {
		t.Errorf("long reason not bounded: %d runes", len([]rune(j.Reason)))
	}
}

func TestAttributesString(t *testing.T) {
	if got := (Attributes{Resource: "pods", Subresource: "log", Verb: "get", Namespace: "a", Name: "api"}).String(); got != `get pods/log.core "api" in namespace a` {
		t.Errorf("got %q", got)
	}
	if got := (Attributes{Group: "apps", Resource: "deployments", Verb: "create"}).String(); got != "create deployments.apps cluster-wide" {
		t.Errorf("got %q", got)
	}
}

func TestCachedReviewerCachesConclusiveAnswers(t *testing.T) {
	now := time.Unix(0, 0)
	var calls atomic.Int32
	c := NewCachedReviewer(reviewerFunc(func(context.Context, Identity, Attributes) (bool, error) {
		calls.Add(1)

		return true, nil
	}), 100*time.Millisecond, func() time.Time { return now })
	ask := func(id Identity, attrs Attributes) {
		if ok, err := c.Allowed(context.Background(), id, attrs); !ok || err != nil {
			t.Fatalf("Allowed = %v %v", ok, err)
		}
	}

	ask(alice, listPods)
	ask(alice, listPods)
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
	with := func(f func(*Attributes)) Attributes { a := listPods; f(&a); return a }
	ask(alice, with(func(a *Attributes) { a.Verb = "create" }))
	ask(alice, with(func(a *Attributes) { a.Namespace = "b" }))
	ask(alice, with(func(a *Attributes) { a.Subresource = "log" }))
	ask(bob, listPods)
	// Same identity with reordered groups shares the entry.
	ask(Identity{User: alice.User, Groups: []string{"devs", "system:authenticated"}}, listPods)
	if calls.Load() != 5 {
		t.Fatalf("calls = %d, want 5", calls.Load())
	}
	now = now.Add(101 * time.Millisecond)
	ask(alice, listPods)
	if calls.Load() != 6 {
		t.Errorf("expired answer served")
	}
}

func TestCachedReviewerSharesInFlightAndSkipsErrors(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	c := NewCachedReviewer(reviewerFunc(func(context.Context, Identity, Attributes) (bool, error) {
		if calls.Add(1) == 1 {
			return false, ErrInconclusive
		}
		<-release

		return false, nil
	}), time.Hour, nil)

	if _, err := c.Allowed(context.Background(), alice, listPods); !errors.Is(err, ErrInconclusive) {
		t.Fatalf("err = %v", err)
	}
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			if ok, err := c.Allowed(context.Background(), alice, listPods); ok || err != nil {
				t.Errorf("Allowed = %v %v", ok, err)
			}
		})
	}
	for calls.Load() < 2 {
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want the failure plus one shared review", calls.Load())
	}
}

func TestCachedReviewerInvalidation(t *testing.T) {
	var calls atomic.Int32
	c := NewCachedReviewer(reviewerFunc(func(context.Context, Identity, Attributes) (bool, error) {
		calls.Add(1)

		return true, nil
	}), time.Hour, nil)
	ctx := context.Background()

	_, _ = c.Allowed(ctx, alice, listPods)
	_, _ = c.Allowed(ctx, alice, Attributes{Namespace: "b", Resource: "pods", Verb: "list"})
	_, _ = c.Allowed(ctx, bob, listPods)
	_, _ = c.Allowed(ctx, bob, Attributes{Resource: "pods", Verb: "list"}) // cluster-wide
	_, _ = c.Allowed(ctx, Identity{User: bob.User, Groups: []string{"extra"}}, Attributes{Namespace: "c", Resource: "pods", Verb: "list"})
	if c.Len() != 5 {
		t.Fatalf("Len = %d", c.Len())
	}
	if n := c.InvalidateNamespace("a"); n != 2 {
		t.Errorf("InvalidateNamespace = %d", n)
	}
	// Matches the user whatever groups it was reviewed with.
	if n := c.InvalidateUser(bob.User); n != 2 {
		t.Errorf("InvalidateUser = %d", n)
	}
	if n := c.Clear(); n != 1 {
		t.Errorf("Clear = %d", n)
	}
	before := calls.Load()
	_, _ = c.Allowed(ctx, alice, listPods)
	if calls.Load() != before+1 {
		t.Error("cleared answer served")
	}
}

func TestCachedReviewerDisabled(t *testing.T) {
	var calls atomic.Int32
	c := NewCachedReviewer(reviewerFunc(func(context.Context, Identity, Attributes) (bool, error) {
		calls.Add(1)

		return true, nil
	}), 0, nil)
	_, _ = c.Allowed(context.Background(), alice, listPods)
	_, _ = c.Allowed(context.Background(), alice, listPods)
	if calls.Load() != 2 || c.Len() != 0 {
		t.Errorf("calls = %d, Len = %d", calls.Load(), c.Len())
	}
}

type judgeFunc func(ctx context.Context, id Identity, attrs Attributes) Judgement

func (f judgeFunc) MayPerform(ctx context.Context, id Identity, attrs Attributes) Judgement {
	return f(ctx, id, attrs)
}

func answering(answer func(namespace string) Verdict, seen *[]Attributes) Judge {
	var mu sync.Mutex

	return judgeFunc(func(_ context.Context, _ Identity, attrs Attributes) Judgement {
		mu.Lock()
		if seen != nil {
			*seen = append(*seen, attrs)
		}
		mu.Unlock()

		return Judgement{Verdict: answer(attrs.Namespace)}
	})
}

func listing(names ...string) func(context.Context) ([]string, error) {
	return func(context.Context) ([]string, error) { return names, nil }
}

func TestScopeClusterWideSkipsSweep(t *testing.T) {
	var seen []Attributes
	r := &ScopeResolver{ListNamespaces: listing("b", "a"), Judge: answering(func(string) Verdict { return Yes }, &seen)}

	scope, err := r.Resolve(context.Background(), alice, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !scope.ClusterWide || !slices.Equal(scope.Namespaces, []string{"a", "b"}) || scope.Total != 2 || scope.Truncated {
		t.Errorf("scope = %+v", scope)
	}
	if len(seen) != 1 || seen[0] != VisibilityProbe {
		t.Errorf("reviews = %+v", seen)
	}
}

func TestScopeSeparatesDeniedFromInconclusive(t *testing.T) {
	r := &ScopeResolver{ListNamespaces: listing("c", "b", "a"), Judge: answering(func(ns string) Verdict {
		switch ns {
		case "a":
			return Yes
		case "c":
			return Unknown
		default:
			return No
		}
	}, nil)}

	scope, err := r.Resolve(context.Background(), alice, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(scope.Namespaces, []string{"a"}) || !slices.Equal(scope.Unknown, []string{"c"}) ||
		scope.ClusterWide || scope.Total != 3 || scope.Truncated {
		t.Errorf("scope = %+v", scope)
	}
}

func TestScopeBoundsSweepPreferringClaimed(t *testing.T) {
	var all []string
	for i := range 30 {
		all = append(all, fmt.Sprintf("ns-%02d", i))
	}
	var seen []Attributes
	r := &ScopeResolver{
		ListNamespaces: listing(all...),
		Judge: answering(func(ns string) Verdict {
			if ns == "" {
				return No
			}

			return Yes
		}, &seen),
		MaxNamespaces: 5,
		Concurrency:   2,
	}

	scope, err := r.Resolve(context.Background(), alice, []string{"ns-29", "ns-15"})
	if err != nil {
		t.Fatal(err)
	}
	if !scope.Truncated || scope.Total != 30 || !slices.Equal(scope.Namespaces, []string{"ns-00", "ns-01", "ns-02", "ns-15", "ns-29"}) {
		t.Errorf("scope = %+v", scope)
	}
	if len(seen) != 6 {
		t.Errorf("reviews = %d", len(seen))
	}
}

func TestScopeConcurrencyBound(t *testing.T) {
	var inFlight, peak atomic.Int32
	var names []string
	for i := range 20 {
		names = append(names, fmt.Sprintf("ns-%d", i))
	}
	r := &ScopeResolver{
		ListNamespaces: listing(names...),
		Concurrency:    4,
		Judge: judgeFunc(func(_ context.Context, _ Identity, attrs Attributes) Judgement {
			if attrs.Namespace == "" {
				return Judgement{Verdict: No}
			}
			n := inFlight.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			inFlight.Add(-1)

			return Judgement{Verdict: Yes}
		}),
	}

	scope, err := r.Resolve(context.Background(), alice, nil)
	if err != nil || len(scope.Namespaces) != 20 {
		t.Fatalf("scope = %+v, %v", scope, err)
	}
	if peak.Load() != 4 {
		t.Errorf("peak = %d, want 4", peak.Load())
	}
}

func TestScopeListFailure(t *testing.T) {
	boom := errors.New("boom")
	r := &ScopeResolver{
		ListNamespaces: func(context.Context) ([]string, error) { return nil, boom },
		Judge:          answering(func(string) Verdict { return No }, nil),
	}
	if _, err := r.Resolve(context.Background(), alice, nil); !errors.Is(err, boom) {
		t.Errorf("err = %v", err)
	}
}

type recordedHooks struct {
	mu     sync.Mutex
	events []string
}

func (r *recordedHooks) add(s string) {
	r.mu.Lock()
	r.events = append(r.events, s)
	r.mu.Unlock()
}

func (r *recordedHooks) has(s string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return slices.Contains(r.events, s)
}

func (r *recordedHooks) hooks() WatchHooks {
	return WatchHooks{
		InvalidateNamespace: func(ns string) { r.add("namespace:" + ns) },
		ClearReviews:        func() { r.add("clear") },
		NamespacesChanged:   func() { r.add("namespaces") },
		DiscoveryChanged:    func() { r.add("discovery") },
	}
}

func metadataObject(gvr schema.GroupVersionResource, kind, namespace, name string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: gvr.GroupVersion().String(), Kind: kind},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
	}
}

func TestInvalidationWatch(t *testing.T) {
	existing := metadataObject(roleBindings, "RoleBinding", "existing", "rb")
	scheme := metadatafake.NewTestScheme()
	if err := metav1.AddMetaToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	client := metadatafake.NewSimpleMetadataClient(scheme, existing)
	watchers := map[string]chan struct{}{}
	for _, gvr := range []schema.GroupVersionResource{roles, roleBindings, clusterRoles, clusterRoleBindings, namespaces, crds} {
		watchers[gvr.Resource] = make(chan struct{})
	}
	client.PrependWatchReactor("*", func(action k8stesting.Action) (bool, watch.Interface, error) {
		gvr := action.GetResource()
		w, err := client.Tracker().Watch(gvr, action.GetNamespace())
		if err != nil {
			return false, nil, err
		}
		close(watchers[gvr.Resource])

		return true, w, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec := &recordedHooks{}
	logger := slog.New(slog.DiscardHandler)
	if err := StartInvalidationWatch(ctx, client, rec.hooks(), logger); err != nil {
		t.Fatal(err)
	}
	for resource, started := range watchers {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatalf("watch on %s did not start", resource)
		}
	}

	create := func(gvr schema.GroupVersionResource, kind, ns, name string) {
		obj := metadataObject(gvr, kind, ns, name)
		if err := client.Tracker().Create(gvr, obj, ns); err != nil {
			t.Fatal(err)
		}
	}
	create(roleBindings, "RoleBinding", "team-a", "edit")
	create(clusterRoles, "ClusterRole", "", "view")
	create(crds, "CustomResourceDefinition", "", "clusters.postgresql.cnpg.io")
	create(namespaces, "Namespace", "", "team-b")
	if err := client.Tracker().Delete(namespaces, "", "team-b"); err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{"namespace:team-a", "clear", "discovery", "namespaces", "namespace:team-b"} {
		deadline := time.Now().Add(5 * time.Second)
		for !rec.has(want) {
			if time.Now().After(deadline) {
				t.Fatalf("hook %q not called; got %v", want, rec.events)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	// Objects present before the watch started are not changes.
	if rec.has("namespace:existing") {
		t.Error("initial list reported as an event")
	}
}
