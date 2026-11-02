package service

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/provisioning"
)

// Prose for an agent that is relaying to a beginner. Lead with the verdict and
// a count; one short paragraph per thing; name real objects so a sentence is
// greppable; and never let an unreadable fact read as a passing one.

func FormatUnavailable(u *Unavailable) string {
	return "## Provisioning facts unavailable — " + strings.ReplaceAll(u.Reason, "_", " ") + "\n\n" + u.Detail
}

func core(group string) string {
	if group == "" {
		return "core"
	}

	return group
}

func FormatPlatform(p *Platform) string {
	var b lines
	b.add(fmt.Sprintf("## Provisioning platform — %d of %d offerings ready, %d storage classes", p.OfferingsReady, p.OfferingsTotal, len(p.StorageClasses)), "")

	zones := "no reported"
	if n := len(p.Topology.Zones); n > 0 {
		zones = strconv.Itoa(n)
	}
	monitoring := "is not"
	if p.MonitoringOperator {
		monitoring = "is"
	}
	b.add(fmt.Sprintf("Scheduling: %d schedulable node(s) across %s zone(s). Network policy engine: %s. Prometheus operator %s present.",
		p.Topology.SchedulableNodes, zones, p.NetworkPolicyEngine, monitoring), "")

	if len(p.StorageClasses) > 0 {
		b.add("### Storage classes", "")
		for _, s := range p.StorageClasses {
			def := ""
			if s.IsDefault {
				def = " (default)"
			}
			expand := "not expandable"
			if s.AllowExpansion {
				expand = "expandable"
			}
			b.add(fmt.Sprintf("- **%s**%s — %s, %s binding, %s reclaim, %s. %s", s.Name, def, s.Provisioner, s.BindingMode, s.ReclaimPolicy, expand, s.Implies))
		}
		b.add("")
	}

	if len(p.PriorityClasses) > 0 {
		b.add("### Priority classes", "")
		for _, c := range p.PriorityClasses {
			def := ""
			if c.IsDefault {
				def = " — default"
			}
			b.add(fmt.Sprintf("- **%s** (%d)%s: %s", c.Name, c.Value, def, c.Meaning))
		}
		b.add("")
	}

	b.add("### Ingress and TLS", "")
	switch {
	case p.Ingress.DomainSuffix == nil:
		b.add("This cluster publishes no ingress domain, so ask the platform team which hostnames you may use.")
	case p.Ingress.DomainSuffixSource != nil && *p.Ingress.DomainSuffixSource == "config":
		b.add("Published hostnames end in `" + *p.Ingress.DomainSuffix + "` (configured on this server rather than read from an admission guard, so it is not verified against any policy).")
	default:
		b.add("Published hostnames end in `" + *p.Ingress.DomainSuffix + "` (read from the admission guard's own parameters).")
	}
	if len(p.Ingress.Classes) > 0 {
		names := make([]string, len(p.Ingress.Classes))
		for i, c := range p.Ingress.Classes {
			names[i] = "`" + c.Name + "`"
			if c.IsDefault {
				names[i] += " (default)"
			}
		}
		b.add("", "Ingress classes: "+strings.Join(names, ", ")+".")
	}
	if p.Ingress.TLSAdvice != "" {
		b.add("", p.Ingress.TLSAdvice)
	}

	if len(p.AdmissionPolicies) > 0 {
		b.add("", "### Admission policies", "",
			"These override RBAC: a policy can reject something your role allows, so they decide what you may actually apply.", "")
		for _, a := range p.AdmissionPolicies {
			mode := "audit only"
			if a.Enforced {
				mode = "enforced"
			}
			guards := make([]string, len(a.Guards))
			for i, g := range a.Guards {
				guards[i] = g.Resource + "." + core(g.Group)
			}
			guarded := strings.Join(guards, ", ")
			if guarded == "" {
				guarded = "nothing listed"
			}
			b.add(fmt.Sprintf("- **%s** — %s (%s); guards %s.", a.Name, mode, a.Enforcement, guarded))
		}
		if p.TenantLabelKey != nil {
			b.add("", "Enforced policies scope tenancy on the namespace label `"+*p.TenantLabelKey+"`.")
		}
	}

	if len(p.Policies) > 0 {
		b.add("", "### Kyverno policies", "")
		for _, k := range p.Policies {
			touches := strings.Join(k.Touches, ", ")
			if touches == "" {
				touches = "unspecified kinds"
			}
			b.add(fmt.Sprintf("- **%s** — %s; touches %s. %s", k.Name, k.Mode, touches, k.Meaning))
		}
	}

	b.add(degradedSection(p.Degraded)...)

	return b.String()
}

func FormatAccessCheck(r *AccessCheck, in AccessCheckInput) string {
	where := " cluster-wide"
	if in.Namespace != "" {
		where = " in namespace " + in.Namespace
	}
	var b lines
	b.add("## "+in.Verb+" "+in.Resource+"."+core(in.Group)+where+" — "+string(r.Verdict), "", r.Reason)
	if len(r.AdmissionDefaults) > 0 {
		b.add("")
		b.add(admissionDefaultLines(r.AdmissionDefaults)...)
	}
	if r.Identity != nil {
		b.add("", "Asked of the cluster authorizer as Kubernetes user `"+r.Identity.User+"`.")
	}

	return b.String()
}

func admissionDefaultLines(defaults []provisioning.AdmissionDefault) []string {
	out := []string{"Admission defaults: these policies rewrite the object on its way in, so the cluster stores more than your " +
		"manifest says. Meet what each one requires before applying:"}
	for _, d := range defaults {
		scoped := ""
		if d.NamespaceScoped {
			scoped = " (only in namespaces its binding selects)"
		}
		description := "it carries no kubernetes.io/description; read its mutations with list_admission_policies."
		if d.Description != nil {
			description = *d.Description
		}
		out = append(out, "- **"+d.Policy+"** on `"+d.Resource+"`"+scoped+": "+description)
	}

	return out
}

func FormatOfferings(r *Offerings) string {
	ready := 0
	for _, o := range r.Offerings {
		if o.Availability.State == provisioning.StateReady {
			ready++
		}
	}
	var b lines
	b.add(fmt.Sprintf("## Offerings — %d of %d ready on this cluster", ready, len(r.Offerings)), "")
	for _, o := range r.Offerings {
		b.add("### "+o.Name+" — "+availabilitySummary(o), "", o.What)
		if len(o.GoodFor) > 0 {
			b.add("", "Good for: "+strings.Join(o.GoodFor, ", ")+".")
		}
		if o.Availability.State != provisioning.StateReady && len(o.Needs) > 0 {
			b.add("", "Before it could be used here: "+strings.Join(o.Needs, "; ")+".")
		}
		if o.Resource != nil {
			version := ""
			if o.APIVersion != nil {
				version = " (" + *o.APIVersion + ")"
			}
			b.add("", "Resource: `"+*o.Resource+"`"+version+".")
		}
		if len(o.AdmissionDefaults) > 0 {
			b.add("")
			b.add(admissionDefaultLines(o.AdmissionDefaults)...)
		}
		if o.MayCreate != nil {
			b.add("", strings.TrimSpace("May you create it there: **"+string(*o.MayCreate)+"**. "+o.MayCreateReason))
		}
		b.add("")
	}
	if len(r.Withheld) > 0 {
		b.add("No per-namespace verdict for "+quoteAll(r.Withheld)+": "+
			"the cluster authorizer does not let you list pods there, or could not say.", "")
	}
	b.add(degradedSection(r.Degraded)...)

	return b.String()
}

func quoteAll(names []string) string {
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = "`" + n + "`"
	}

	return strings.Join(quoted, ", ")
}

// FormatReadiness renders namespace readiness. includeAccess adds the access
// summary; MCP responses omit it and expose creatable names only.
func FormatReadiness(r *Readiness, includeAccess bool) string {
	var b lines
	b.add(fmt.Sprintf("## Namespace readiness — %d of %d namespace(s) reported", len(r.Namespaces), len(r.Requested)), "")
	if len(r.Withheld) > 0 {
		b.add("No facts were returned for "+quoteAll(r.Withheld)+": "+
			"the cluster authorizer does not let you list pods there, or could not say. That is about your access, not about whether the namespace exists.", "")
	}

	for _, f := range r.Namespaces {
		tenant := ""
		if f.Tenant != nil {
			tenant = " (`" + f.Tenant.LabelKey + "=" + f.Tenant.ID + "`)"
		}
		b.add("### "+f.Namespace+tenant, "")
		if includeAccess {
			b.add(accessSentence(f), "")
		}
		b.add("Permission to create the requested offering here: **"+string(f.MayCreate)+"** — "+f.MayCreateReason, "", quotaSentence(f))
		if f.LimitRange != nil {
			b.add("", "A LimitRange applies defaults to containers that set none: "+
				describeAmounts(f.LimitRange.Default)+" limit, "+describeAmounts(f.LimitRange.DefaultRequest)+" request. "+
				"A workload that ships without its own `resources` block inherits these, which is a common cause of OOM kills.")
		}
		cilium := ""
		if f.Network.CiliumAvailable {
			cilium = ", Cilium policies available"
		}
		b.add("", "Network: ingress "+string(f.Network.Ingress)+", egress "+string(f.Network.Egress)+cilium+".")

		var specific []string
		for _, s := range f.Network.Selectors {
			if s.LabelValue != nil {
				specific = append(specific, "`"+s.Policy+"` admits only `"+s.LabelKey+"="+*s.LabelValue+"`")
			}
		}
		if len(specific) > 0 {
			b.add("", "Some policies here select on an **exact instance name**: "+strings.Join(specific, "; ")+
				". Name an instance anything else and it gets none of that traffic, with no error that points at the cause.")
		}
		if ps := f.PodSecurity; ps != nil {
			line := "Pod Security Admission enforces **" + ps.Enforce + "**: " + ps.Summary
			if len(ps.Requires) > 0 {
				line += " Pods must set " + strings.Join(ps.Requires, ", ") + "."
			}
			b.add("", line)
		}
		for _, h := range r.HostRules {
			if h.Namespace != f.Namespace {
				continue
			}
			if h.ExactHost == nil {
				b.add("", h.Note)
			} else {
				line := "Hostnames this namespace may claim: `" + *h.ExactHost + "`"
				if h.LabelledPattern != nil {
					line += " or `" + *h.LabelledPattern + "`"
				}
				if len(h.CustomDomains) > 0 {
					line += ", or any name under " + quoteAll(h.CustomDomains)
				}
				b.add("", line+". "+h.Note)
			}

			break
		}
		for _, reg := range f.Registries {
			b.add("")
			b.add(registrySection(reg)...)
		}
		b.add("")
	}
	b.add(degradedSection(r.Degraded)...)

	return b.String()
}

func registrySection(r provisioning.RegistryFact) []string {
	tls := "."
	if !r.TLS {
		tls = ", served without TLS here, so Docker and Skaffold must be told it is an insecure registry."
	}

	return []string{
		"Container registry: Zot at `" + r.Host + "` (Ingress `" + r.Ingress + "` → Service `" + r.Service + "` → Deployment `" + r.Deployment + "`)" + tls,
		"",
		"To build with Skaffold, save these lines as `skaffold.env` next to `skaffold.yaml`. Skaffold reads that file on every run, " +
			"so builds are pushed to this registry and deployed to this namespace through its own kube context, whatever context is current, and `skaffold dev` leaves the deployment running when it exits. " +
			"Keep image names in `skaffold.yaml` bare (`myapp`, not a full reference): Skaffold prefixes them with the default repo. " +
			"The file is specific to this namespace and cluster, so keep it out of version control. " +
			"Prefer it over `skaffold config set default-repo`, which writes to global config instead of the project.",
		"",
		"```",
		r.SkaffoldEnv,
		"```",
		"",
		"Pushing needs credentials the registry accepts: run `docker login " + r.Host + "` first.",
	}
}

func availabilitySummary(o provisioning.OfferingCard) string {
	a := o.Availability
	switch a.State {
	case provisioning.StateReady:
		if a.Version == nil {
			return "ready"
		}
		name := "operator"
		if o.Operator != nil {
			name = o.Operator.Name
		}

		return "ready (" + name + " " + *a.Version + ")"
	case provisioning.StateDegraded:
		return "degraded: " + a.Reason
	case provisioning.StateCRDsOnly:
		return "not usable: " + a.Reason
	default:
		if o.Operator != nil {
			return "not installed on this cluster (" + o.Operator.Name + " is absent)"
		}

		return "not installed on this cluster"
	}
}

var policyInReason = regexp.MustCompile(`admission policy \(([^)]+)\)`)

// accessSentence summarises the matrix as counts and tiers plus per-offering
// verdicts, naming what blocks each: the resources RBAC refuses, or the
// admission policy when RBAC alone would allow it.
func accessSentence(f provisioning.NamespaceFact) string {
	a := f.Access
	if a == nil {
		return "Access: not checked, because the call carried no verified caller. Run `kubectl auth can-i --list -n " + f.Namespace + "` yourself."
	}
	by := a.Summary.ByVerb
	reads := max(by["get"], by["list"], by["watch"])

	var provision []string
	for _, id := range provisioning.OfferingIDs {
		entry, ok := f.Offerings[id]
		if !ok {
			continue
		}
		if entry.Verdict == authz.Yes {
			provision = append(provision, string(id)+" yes")

			continue
		}
		why := ""
		if m := policyInReason.FindStringSubmatch(entry.Reason); m != nil {
			why = "admission policy " + m[1]
		} else {
			var blocked []string
			for _, row := range a.ProvisionDetail[id] {
				if row.Verdict != authz.Yes {
					blocked = append(blocked, row.Resource)
				}
			}
			why = strings.Join(blocked, ", ")
		}
		if why != "" {
			why = " (" + why + ")"
		}
		provision = append(provision, string(id)+" "+string(entry.Verdict)+why)
	}
	provisionText := strings.Join(provision, ", ")
	if provisionText == "" {
		provisionText = "no offerings served"
	}

	var oddities []string
	for _, key := range slices.Sorted(maps.Keys(a.Matrix)) {
		if row := a.Matrix[key]; row["create"] == authz.Yes && row["delete"] == authz.No {
			oddities = append(oddities, strings.TrimPrefix(key, "/"))
		}
	}

	s := fmt.Sprintf("Access (from the cluster authorizer): may create %d of %d resource types, read %d, update %d, delete %d; view %s, edit %s, admin %s. Provision: %s.",
		by["create"], a.Summary.ResourceTypes, reads, by["update"], by["delete"], a.View, a.Edit, a.Admin, provisionText)
	if len(oddities) > 0 {
		more := ""
		if len(oddities) > 5 {
			more = " and more"
			oddities = oddities[:5]
		}
		s += " Create without delete on " + strings.Join(oddities, ", ") + more + "."
	}
	if a.Summary.Unknown > 0 {
		s += fmt.Sprintf(" %d of %d reviews could not be evaluated and read as unknown.", a.Summary.Unknown, a.Summary.ResourceTypes*len(provisioning.Verbs))
	}

	return s
}

func quotaSentence(f provisioning.NamespaceFact) string {
	if f.Quota == nil {
		return "No ResourceQuota applies here, so the namespace has no budget of its own."
	}
	h := f.Headroom
	if h == nil {
		return "ResourceQuota `" + f.Quota.Name + "` applies: " + describeAmounts(f.Quota.Hard) + " allowed."
	}
	pvcs := "an unreported number of"
	if h.PVCCount != nil {
		pvcs = strconv.FormatInt(*h.PVCCount, 10)
	}

	return "ResourceQuota `" + f.Quota.Name + "`: " + formatMillis(h.CPUMillis) + " CPU, " + formatBytes(h.MemoryBytes) + " memory, " +
		formatBytes(h.StorageBytes) + " storage and " + pvcs + " PVC(s) still free."
}

func describeAmounts(amounts provisioning.QuotaAmounts) string {
	if len(amounts) == 0 {
		return "nothing specified"
	}
	var parts []string
	for _, k := range slices.Sorted(maps.Keys(amounts)) {
		parts = append(parts, k+"="+amounts[k])
	}

	return strings.Join(parts, ", ")
}

func formatMillis(v *int64) string {
	if v == nil {
		return "an unreported amount of"
	}

	return strconv.FormatInt(*v, 10) + "m"
}

func formatBytes(v *float64) string {
	if v == nil {
		return "an unreported amount of"
	}
	if gi := *v / (1 << 30); gi >= 1 {
		return strconv.FormatFloat(gi, 'f', 1, 64) + "Gi"
	}

	return strconv.FormatInt(int64(*v/(1<<20)+0.5), 10) + "Mi"
}

// degradedSection is never dropped. A refused read that reads as an empty
// result is the one failure mode this layer exists to prevent.
func degradedSection(degraded []provisioning.DegradedRead) []string {
	if len(degraded) == 0 {
		return nil
	}
	out := []string{"", "### Facts that could not be read", "",
		"Treat anything below as unknown rather than absent — these reads failed, they did not come back empty.", ""}
	for _, d := range degraded {
		out = append(out, fmt.Sprintf("- **%s** (HTTP %d): %s", d.Source, d.Status, d.Message))
	}

	return out
}

type lines []string

func (l *lines) add(s ...string) { *l = append(*l, s...) }

func (l lines) String() string { return strings.Join(l, "\n") }
