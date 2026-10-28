package ui

import (
	"errors"
	"html/template"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/codemowers/driftmower-mcp/internal/catalog"
	"github.com/codemowers/driftmower-mcp/internal/observability"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower-mcp/internal/workloads"
)

var funcs = template.FuncMap{
	"join": strings.Join,
	"deref": func(s *string) string {
		if s == nil {
			return ""
		}

		return *s
	},
	"quantity": formatQuantity,
	// A nil slice is a list that could not be read, unlike an empty one.
	"unavailable": func(b []catalog.Binding) bool { return b == nil },
	"millis": func(v *int64) string {
		if v == nil {
			return "unlimited"
		}

		return strconv.FormatInt(*v, 10) + "m"
	},
	"metricRow": metricRows,
}

func (u *UI) namespaces(r request) (string, view, error) {
	scope, err := u.Scope.Resolve(r.Context(), r.identity, nil)

	return "namespaces", view{Title: "Namespaces", Data: scope}, err
}

type workloadRow struct {
	*workloads.Workload
	Restartable bool
}

type namespacePage struct {
	Namespace string
	Rows      []workloadRow
	Warnings  []string
	Pods      []string
	Actions   bool
	Readiness bool
	Usage     bool
}

func (u *UI) namespace(r request) (string, view, error) {
	ns := r.PathValue("namespace")
	page := namespacePage{Namespace: ns, Actions: u.Actions != nil, Readiness: u.Provisioning != nil,
		Usage: u.Observability != nil && u.Observability.MetricsEnabled()}
	v := view{Title: ns, Message: r.URL.Query().Get("message"), Data: &page}
	if u.Workloads == nil {
		return "namespace", v, nil
	}
	inv, err := u.Workloads.List(r.Context(), ns, r.identity)
	if err != nil {
		return "namespace", v, err
	}
	page.Warnings = inv.Warnings
	for _, w := range inv.Workloads {
		_, restartable := workloads.RestartAdapterFor(w.APIVersion, w.Kind)
		page.Rows = append(page.Rows, workloadRow{Workload: w, Restartable: restartable && !w.OwnerReferenceOnly})
		page.Pods = append(page.Pods, w.Pods...)
	}
	slices.Sort(page.Pods)

	return "namespace", v, nil
}

func (u *UI) restart(r request) (string, error) {
	if u.Actions == nil {
		return "", errors.New("workload actions are disabled")
	}
	result, err := u.Actions.Restart(r.Context(), workloads.RestartInput{
		Target:     workloads.Target{Namespace: r.PathValue("namespace"), Name: r.PostFormValue("name"), UID: r.PostFormValue("uid")},
		APIVersion: r.PostFormValue("apiVersion"), Kind: r.PostFormValue("kind"),
	}, r.identity)
	if err != nil {
		return "", err
	}

	return r.PostFormValue("kind") + "/" + r.PostFormValue("name") + ": " + result.Message, nil
}

func (u *UI) terminate(r request) (string, error) {
	if u.Actions == nil {
		return "", errors.New("workload actions are disabled")
	}
	result, err := u.Actions.Terminate(r.Context(), workloads.Target{Namespace: r.PathValue("namespace"), Name: r.PostFormValue("name"), UID: r.PostFormValue("uid")}, r.identity)
	if err != nil {
		return "", err
	}

	return "Pod/" + r.PostFormValue("name") + ": " + result.Message, nil
}

type readinessPage struct {
	Namespace string
	Readiness *service.Readiness
}

func (u *UI) readiness(r request) (string, view, error) {
	ns := r.PathValue("namespace")
	page := readinessPage{Namespace: ns}
	v := view{Title: "Readiness of " + ns, Data: &page}
	if u.Provisioning == nil {
		return "readiness", v, errors.New("provisioning facts are not available")
	}
	result, unavailable := u.Provisioning.DescribeNamespaceReadiness(r.Context(), &r.identity, []string{ns}, "")
	if unavailable != nil {
		return "readiness", v, errors.New(unavailable.Detail)
	}
	page.Readiness = result

	return "readiness", v, nil
}

type usagePage struct {
	Namespace string
	Pod       string
	Usage     *observability.Usage
}

func (u *UI) podUsage(r request) (string, view, error) {
	page := usagePage{Namespace: r.PathValue("namespace"), Pod: r.PathValue("pod")}
	v := view{Title: page.Pod, Data: &page}
	if u.Observability == nil || !u.Observability.MetricsEnabled() {
		return "usage", v, errors.New("Prometheus is not configured") //nolint:staticcheck // Prometheus is a proper noun.
	}
	var err error
	page.Usage, err = u.Observability.PodUsage(r.Context(), r.identity, observability.PodUsageInput{
		Namespace: page.Namespace, Pod: page.Pod, WindowSeconds: 300, PerContainer: true}, nil)

	return "usage", v, err
}

func (u *UI) clusterUsage(r request) (string, view, error) {
	page := usagePage{}
	v := view{Title: "Cluster resource usage", Data: &page}
	if u.Observability == nil || !u.Observability.MetricsEnabled() {
		return "usage", v, errors.New("Prometheus is not configured") //nolint:staticcheck // Prometheus is a proper noun.
	}
	var err error
	page.Usage, err = u.Observability.ClusterUsage(r.Context(), r.identity, observability.ClusterUsageInput{WindowSeconds: 300}, nil)

	return "usage", v, err
}

type catalogPage struct {
	Policies       []catalog.AdmissionPolicy
	CRDs           []catalog.CustomResource
	StorageClasses []catalog.StorageClass
	Classes        catalog.PlatformClasses
	Errors         []string
}

func (u *UI) catalog(r request) (string, view, error) {
	page := catalogPage{}
	v := view{Title: "Cluster catalog", Data: &page}
	if u.Catalog == nil {
		return "catalog", v, errors.New("the cluster catalog is not available")
	}
	ctx := r.Context()
	note := func(what string, err error) {
		if err != nil {
			page.Errors = append(page.Errors, what+": "+err.Error())
		}
	}
	policies, err := u.Catalog.AdmissionPolicies(ctx)
	note("admission policies", err)
	page.Policies = policies.Policies
	crds, err := u.Catalog.CustomResourceDefinitions(ctx)
	note("custom resource definitions", err)
	issuerVersion := ""
	for _, c := range crds {
		if c.Scope == "Namespaced" {
			page.CRDs = append(page.CRDs, c)
		}
		if c.Name == "clusterissuers.cert-manager.io" && c.Established && !c.Terminating {
			issuerVersion = c.PreferredServedVersion()
		}
	}
	page.StorageClasses, err = u.Catalog.StorageClasses(ctx)
	note("storage classes", err)
	page.Classes = u.Catalog.PlatformClasses(ctx, issuerVersion, "")
	for _, d := range page.Classes.Degraded {
		page.Errors = append(page.Errors, d.Source+": "+d.Message)
	}

	return "catalog", v, nil
}

// formatQuantity renders a total in its unit; nil is unavailable, not zero.
func formatQuantity(unit string, v *float64) string {
	if v == nil {
		return "unavailable"
	}
	switch unit {
	case "bytes":
		return formatBytes(*v)
	case "bytes/second":
		return formatBytes(*v) + "/s"
	case "ratio":
		return strconv.FormatFloat(*v*100, 'f', 1, 64) + "%"
	case "cores":
		return strconv.FormatFloat(*v, 'f', 3, 64) + " cores"
	default:
		return strconv.FormatFloat(*v, 'g', 4, 64) + " " + unit
	}
}

func formatBytes(v float64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}

	return strconv.FormatFloat(v, 'f', 1, 64) + " " + units[i]
}

type metricRow struct {
	Name     string
	Value    string
	Notes    string
	Unusable bool
}

func metricRows(m map[string]*observability.Quantity) []metricRow {
	rows := make([]metricRow, 0, len(m))
	for _, name := range slices.Sorted(maps.Keys(m)) {
		q := m[name]
		notes := strings.Join(q.Warnings, " ")
		if q.Error != "" {
			notes = strings.TrimSpace(q.Error + " " + notes)
		}
		rows = append(rows, metricRow{Name: name, Value: formatQuantity(q.Unit, q.Total), Notes: notes, Unusable: q.Total == nil})
	}

	return rows
}
