// Package securitymetrics exports bounded evidence about active Pods and their
// Kubernetes RBAC. It reads on scrape and retains no Pod, RBAC or response cache.
package securitymetrics

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/sync/errgroup"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

type Exporter struct {
	Kubernetes             kubernetes.Interface
	Logger                 *slog.Logger
	ServiceAccountsEnabled bool
}
type snapshot struct {
	pods            []corev1.Pod
	roles           []rbacv1.Role
	clusterRoles    []rbacv1.ClusterRole
	bindings        []rbacv1.RoleBinding
	clusterBindings []rbacv1.ClusterRoleBinding
}

func (e *Exporter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	var data snapshot
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		v, err := e.Kubernetes.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
		if err == nil {
			data.pods = v.Items
		}
		return err
	})
	if e.ServiceAccountsEnabled {
		g.Go(func() error {
			v, err := e.Kubernetes.RbacV1().Roles("").List(ctx, metav1.ListOptions{})
			if err == nil {
				data.roles = v.Items
			}
			return err
		})
		g.Go(func() error {
			v, err := e.Kubernetes.RbacV1().ClusterRoles().List(ctx, metav1.ListOptions{})
			if err == nil {
				data.clusterRoles = v.Items
			}
			return err
		})
		g.Go(func() error {
			v, err := e.Kubernetes.RbacV1().RoleBindings("").List(ctx, metav1.ListOptions{})
			if err == nil {
				data.bindings = v.Items
			}
			return err
		})
		g.Go(func() error {
			v, err := e.Kubernetes.RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
			if err == nil {
				data.clusterBindings = v.Items
			}
			return err
		})
	}
	if err := g.Wait(); err != nil {
		if e.Logger != nil {
			e.Logger.WarnContext(r.Context(), "security inventory scrape failed", "error", err)
		}
		http.Error(w, "security inventory unavailable", http.StatusServiceUnavailable)
		return
	}
	rows, err := data.metrics()
	if err != nil {
		if e.Logger != nil {
			e.Logger.WarnContext(r.Context(), "security RBAC inventory incomplete", "error", err)
		}
		http.Error(w, "security RBAC inventory incomplete", http.StatusServiceUnavailable)
		return
	}
	registry := prometheus.NewRegistry()
	registry.MustRegister(metricRows(rows))
	promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(w, r)
}

var descs = map[string]*prometheus.Desc{
	"images":     prometheus.NewDesc("driftmower_running_image_containers", "Running containers by namespace and immutable image digest; terminal Pods and stopped containers are excluded.", []string{"namespace", "digest"}, nil),
	"unresolved": prometheus.NewDesc("driftmower_running_image_unresolved_containers", "Running containers whose runtime image ID has no supported immutable sha256 digest; their vulnerability coverage is unknown.", []string{"namespace"}, nil),
	"exposure":   prometheus.NewDesc("driftmower_serviceaccount_exposure", "Active (Running or Pending) Pods assigned a ServiceAccount with the observed Kubernetes RBAC risk. Permission scope is cluster or namespace/name. Does not prove a mounted token, exploitation, or cloud permissions.", []string{"namespace", "serviceaccount", "risk", "permission_scope"}, nil),
	"success":    prometheus.NewDesc("driftmower_security_inventory_timestamp_seconds", "Unix timestamp of a complete Pod and RBAC inventory read.", nil, nil),
}

type metricRows []prometheus.Metric

func (metricRows) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range descs {
		ch <- d
	}
}
func (rows metricRows) Collect(ch chan<- prometheus.Metric) {
	for _, m := range rows {
		ch <- m
	}
}

type account struct{ namespace, name string }
type imageKey struct{ namespace, digest string }
type exposure struct {
	account     account
	risk, scope string
}

func (s snapshot) metrics() ([]prometheus.Metric, error) {
	active := map[account]int{}
	images := map[imageKey]int{}
	unresolved := map[string]int{}
	for _, pod := range s.pods {
		if pod.DeletionTimestamp != nil || (pod.Status.Phase != corev1.PodRunning && pod.Status.Phase != corev1.PodPending) {
			continue
		}
		name := pod.Spec.ServiceAccountName
		if name == "" {
			name = "default"
		}
		active[account{pod.Namespace, name}]++
		statuses := append(slices.Clone(pod.Status.ContainerStatuses), pod.Status.InitContainerStatuses...)
		statuses = append(statuses, pod.Status.EphemeralContainerStatuses...)
		for _, status := range statuses {
			if status.State.Running == nil {
				continue
			}
			digest := ""
			if i := strings.LastIndex(status.ImageID, "sha256:"); i >= 0 {
				value := status.ImageID[i:]
				if len(value) == 71 && strings.Trim(value[7:], "0123456789abcdef") == "" {
					digest = value
				}
			}
			if digest == "" {
				unresolved[pod.Namespace]++
				continue
			}
			images[imageKey{pod.Namespace, digest}]++
		}
	}
	roles := map[string][]rbacv1.PolicyRule{}
	for _, role := range s.roles {
		roles[role.Namespace+"/"+role.Name] = role.Rules
	}
	clusterRoles := map[string][]rbacv1.PolicyRule{}
	for _, role := range s.clusterRoles {
		clusterRoles[role.Name] = role.Rules
	}
	exposures := map[exposure]bool{}
	apply := func(subjects []rbacv1.Subject, namespace, kind, name string) error {
		matchedAccounts := []account{}
		for sa := range active {
			matched := false
			for _, subject := range subjects {
				switch subject.Kind {
				case "ServiceAccount":
					ns := subject.Namespace
					if ns == "" {
						ns = namespace
					}
					matched = matched || (ns == sa.namespace && subject.Name == sa.name)
				case "User":
					matched = matched || subject.Name == "system:serviceaccount:"+sa.namespace+":"+sa.name
				case "Group":
					matched = matched || subject.Name == "system:authenticated" || subject.Name == "system:serviceaccounts" || subject.Name == "system:serviceaccounts:"+sa.namespace
				}
			}
			if matched {
				matchedAccounts = append(matchedAccounts, sa)
			}
		}
		if len(matchedAccounts) == 0 {
			return nil
		}
		var rules []rbacv1.PolicyRule
		var ok bool
		scope := "namespace/" + namespace
		if kind == "ClusterRole" {
			rules, ok = clusterRoles[name]
		} else if kind == "Role" && namespace != "" {
			rules, ok = roles[namespace+"/"+name]
		}
		if !ok {
			return fmt.Errorf("unresolved %s reference %s/%s for an active ServiceAccount", kind, namespace, name)
		}
		if namespace == "" {
			scope = "cluster"
		}
		for _, sa := range matchedAccounts {
			for _, rule := range rules {
				for _, risk := range risks(rule, namespace == "") {
					exposures[exposure{sa, risk, scope}] = true
				}
			}
		}
		return nil
	}
	for _, binding := range s.bindings {
		if len(binding.Subjects) > 0 {
			if err := apply(binding.Subjects, binding.Namespace, binding.RoleRef.Kind, binding.RoleRef.Name); err != nil {
				return nil, err
			}
		}
	}
	for _, binding := range s.clusterBindings {
		if len(binding.Subjects) > 0 {
			if err := apply(binding.Subjects, "", binding.RoleRef.Kind, binding.RoleRef.Name); err != nil {
				return nil, err
			}
		}
	}
	rows := []prometheus.Metric{prometheus.MustNewConstMetric(descs["success"], prometheus.GaugeValue, float64(time.Now().Unix()))}
	for k, count := range images {
		rows = append(rows, prometheus.MustNewConstMetric(descs["images"], prometheus.GaugeValue, float64(count), k.namespace, k.digest))
	}
	for namespace, count := range unresolved {
		rows = append(rows, prometheus.MustNewConstMetric(descs["unresolved"], prometheus.GaugeValue, float64(count), namespace))
	}
	for risk := range exposures {
		rows = append(rows, prometheus.MustNewConstMetric(descs["exposure"], prometheus.GaugeValue, float64(active[risk.account]), risk.account.namespace, risk.account.name, risk.risk, risk.scope))
	}
	return rows, nil
}

func risks(rule rbacv1.PolicyRule, cluster bool) []string {
	// Named-object grants cannot establish unrestricted namespace/cluster admin.
	// Do not report their read access as unrestricted Secret access either.
	unrestricted := len(rule.ResourceNames) == 0
	has := func(values []string, value string) bool {
		return slices.Contains(values, "*") || slices.Contains(values, value)
	}
	out := []string{}
	if unrestricted && slices.Contains(rule.Verbs, "*") && slices.Contains(rule.APIGroups, "*") && slices.Contains(rule.Resources, "*") {
		if cluster {
			out = append(out, "cluster_admin")
		} else {
			out = append(out, "namespace_admin")
		}
		return out
	} else if unrestricted && len(rule.Resources) > 0 && (slices.Contains(rule.Verbs, "*") || (slices.Contains(rule.Resources, "*") && (has(rule.Verbs, "create") || has(rule.Verbs, "update") || has(rule.Verbs, "patch") || has(rule.Verbs, "delete")))) {
		out = append(out, "wildcard_write")
	}
	if unrestricted && has(rule.APIGroups, "") && has(rule.Resources, "secrets") && (has(rule.Verbs, "get") || has(rule.Verbs, "list") || has(rule.Verbs, "watch")) {
		out = append(out, "secrets_read")
	}
	if unrestricted && has(rule.APIGroups, "") && has(rule.Resources, "serviceaccounts/token") && has(rule.Verbs, "create") {
		out = append(out, "token_create")
	}
	if has(rule.Verbs, "impersonate") && ((has(rule.APIGroups, "") && (has(rule.Resources, "users") || has(rule.Resources, "groups") || has(rule.Resources, "serviceaccounts"))) || (has(rule.APIGroups, "authentication.k8s.io") && has(rule.Resources, "userextras/*"))) {
		out = append(out, "impersonate")
	}
	if has(rule.APIGroups, "rbac.authorization.k8s.io") && (has(rule.Resources, "roles") || has(rule.Resources, "clusterroles")) && (has(rule.Verbs, "bind") || has(rule.Verbs, "escalate")) {
		out = append(out, "rbac_escalate")
	}
	return out
}
