package securitymetrics

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestActiveServiceAccountExposureHonorsBindingScopeAndGroups(t *testing.T) {
	admin := rbacv1.PolicyRule{APIGroups: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"*"}}
	data := snapshot{
		pods: []corev1.Pod{
			{ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "running"}, Spec: corev1.PodSpec{ServiceAccountName: "worker"}, Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "app", ImageID: "docker-pullable://repo@sha256:" + strings.Repeat("a", 64), State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}, {Name: "init", ImageID: "sha256:" + strings.Repeat("b", 64), State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{}}}}}},
			{ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "finished"}, Spec: corev1.PodSpec{ServiceAccountName: "worker"}, Status: corev1.PodStatus{Phase: corev1.PodSucceeded}},
		},
		clusterRoles:    []rbacv1.ClusterRole{{ObjectMeta: metav1.ObjectMeta{Name: "custom-admin"}, Rules: []rbacv1.PolicyRule{admin}}},
		clusterBindings: []rbacv1.ClusterRoleBinding{{RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "custom-admin"}, Subjects: []rbacv1.Subject{{Kind: "Group", Name: "system:serviceaccounts:app"}}}},
		bindings:        []rbacv1.RoleBinding{{ObjectMeta: metav1.ObjectMeta{Namespace: "other"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "custom-admin"}, Subjects: []rbacv1.Subject{{Kind: "ServiceAccount", Namespace: "app", Name: "worker"}}}},
	}
	rows, err := data.metrics()
	if err != nil {
		t.Fatal(err)
	}
	want := `# HELP driftmower_serviceaccount_exposure Active (Running or Pending) Pods assigned a ServiceAccount with the observed Kubernetes RBAC risk. Permission scope is cluster or namespace/name. Does not prove a mounted token, exploitation, or cloud permissions.
# TYPE driftmower_serviceaccount_exposure gauge
driftmower_serviceaccount_exposure{namespace="app",permission_scope="cluster",risk="cluster_admin",serviceaccount="worker"} 1
driftmower_serviceaccount_exposure{namespace="app",permission_scope="namespace/other",risk="namespace_admin",serviceaccount="worker"} 1
`
	if err := testutil.CollectAndCompare(metricRows(rows), strings.NewReader(want), "driftmower_serviceaccount_exposure"); err != nil {
		t.Fatal(err)
	}
	if n := testutil.CollectAndCount(metricRows(rows), "driftmower_running_image_containers"); n != 1 {
		t.Fatalf("running image observations %d", n)
	}
	// A deleted Role referenced only by a user or inactive account does not
	// invalidate the active-ServiceAccount inventory.
	data.bindings = append(data.bindings, rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Namespace: "app"}, RoleRef: rbacv1.RoleRef{Kind: "Role", Name: "deleted"}, Subjects: []rbacv1.Subject{{Kind: "User", Name: "old-user"}}})
	if _, err := data.metrics(); err != nil {
		t.Fatal(err)
	}
	data.clusterRoles = nil
	if _, err := data.metrics(); err == nil {
		t.Fatal("unresolved role treated as clean")
	}
}

func TestRiskDetectionDoesNotConfuseReadAccessOrNamedGrantsWithAdmin(t *testing.T) {
	for _, tc := range []struct {
		name string
		rule rbacv1.PolicyRule
		want string
	}{
		{"read pods", rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list"}}, ""},
		{"read secrets", rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get"}}, "secrets_read"},
		{"named secret", rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get"}, ResourceNames: []string{"own"}}, ""},
		{"named impersonation", rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"users"}, Verbs: []string{"impersonate"}, ResourceNames: []string{"admin"}}, "impersonate"},
		{"named bind", rbacv1.PolicyRule{APIGroups: []string{"rbac.authorization.k8s.io"}, Resources: []string{"clusterroles"}, Verbs: []string{"bind"}, ResourceNames: []string{"cluster-admin"}}, "rbac_escalate"},
		{"token mint", rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"serviceaccounts/token"}, Verbs: []string{"create"}}, "token_create"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := risks(tc.rule, true)
			if tc.want == "" && len(got) != 0 || tc.want != "" && !slices.Contains(got, tc.want) {
				t.Fatalf("risks %v", got)
			}
		})
	}
}

func TestInventoryFailureDoesNotExportAnEmptySuccess(t *testing.T) {
	kube := fake.NewClientset()
	kube.PrependReactor("list", "roles", func(ktesting.Action) (bool, runtime.Object, error) { return true, nil, fmt.Errorf("forbidden") })
	w := httptest.NewRecorder()
	(&Exporter{Kubernetes: kube, ServiceAccountsEnabled: true}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/security-metrics", nil))
	if w.Code != 503 || strings.Contains(w.Body.String(), "driftmower_security_inventory_timestamp_seconds") {
		t.Fatalf("failure %d: %s", w.Code, w.Body)
	}
}
