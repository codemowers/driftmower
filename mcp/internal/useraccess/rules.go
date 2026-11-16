package useraccess

import (
	"slices"
	"strings"

	authorizationv1 "k8s.io/api/authorization/v1"
)

// Grant is one row of effective rights: verbs on one resource, optionally
// limited to named objects, in the listed namespaces or cluster-wide.
type Grant struct {
	// API group; "" is the core group and "*" every group.
	Group    string `json:"group"`
	Resource string `json:"resource"`
	// Kind from discovery, when the resource is served; empty for wildcards.
	Kind string `json:"kind,omitempty"`
	// The resource itself is cluster-scoped (Nodes, Namespaces, CRDs), so it
	// is only reachable through cluster-wide rules.
	ClusterScoped bool `json:"clusterScoped,omitempty"`
	// Empty means every object.
	ResourceNames []string `json:"resourceNames,omitempty"`
	Verbs         []string `json:"verbs"`
	// Namespaces where this grant applies beyond the cluster-wide rules.
	// Empty on cluster-wide grants.
	Namespaces []string `json:"namespaces,omitempty"`
}

// NonResourceGrant covers API paths such as /healthz.
type NonResourceGrant struct {
	URLs  []string `json:"urls"`
	Verbs []string `json:"verbs"`
}

// atom is one (group, resource, name, verb) a rule allows. "*" stays a
// literal wildcard; name "" means any object.
type atom struct{ group, resource, name, verb string }

func atoms(rules []authorizationv1.ResourceRule) []atom {
	var out []atom
	for _, r := range rules {
		names := r.ResourceNames
		if len(names) == 0 {
			names = []string{""}
		}
		for _, g := range r.APIGroups {
			for _, res := range r.Resources {
				for _, n := range names {
					for _, v := range r.Verbs {
						out = append(out, atom{g, res, n, v})
					}
				}
			}
		}
	}

	return out
}

func matches(pattern, value string) bool {
	if pattern == "*" || pattern == value {
		return true
	}
	// RBAC allows `pods/*` for every subresource of pods.
	if base, ok := strings.CutSuffix(pattern, "/*"); ok {
		return strings.HasPrefix(value, base+"/")
	}

	return false
}

// covers reports whether b already allows everything a allows.
func (b atom) covers(a atom) bool {
	return matches(b.group, a.group) && matches(b.resource, a.resource) &&
		(b.name == "" || b.name == a.name) && matches(b.verb, a.verb)
}

// subtract drops the atoms that baseline already allows, and duplicates.
func subtract(in, baseline []atom) []atom {
	var out []atom
	seen := map[atom]bool{}
	for _, a := range in {
		if seen[a] || slices.ContainsFunc(baseline, func(b atom) bool { return b.covers(a) }) {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}

	return out
}

// isClusterAdmin reports rules granting every verb on every resource.
func isClusterAdmin(rules []atom) bool {
	return slices.ContainsFunc(rules, func(a atom) bool {
		return a.group == "*" && a.resource == "*" && a.name == "" && a.verb == "*"
	})
}

// grantKey identifies a row before verbs are merged.
type grantKey struct{ group, resource, names string }

// collapse merges atoms into rows of verbs per resource and name set. A "*"
// verb absorbs the others.
func collapse(in []atom) map[grantKey][]string {
	byObject := map[grantKey]map[string][]string{}
	for _, a := range in {
		k := grantKey{group: a.group, resource: a.resource}
		if byObject[k] == nil {
			byObject[k] = map[string][]string{}
		}
		byObject[k][a.verb] = append(byObject[k][a.verb], a.name)
	}
	out := map[grantKey][]string{}
	for k, verbs := range byObject {
		// Rows split by name set: verbs on any object, and verbs on named ones.
		for verb, names := range verbs {
			var key grantKey
			if slices.Contains(names, "") {
				key = grantKey{group: k.group, resource: k.resource}
			} else {
				slices.Sort(names)
				key = grantKey{group: k.group, resource: k.resource, names: strings.Join(slices.Compact(names), "\x00")}
			}
			out[key] = append(out[key], verb)
		}
	}
	for k, verbs := range out {
		slices.Sort(verbs)
		verbs = slices.Compact(verbs)
		if slices.Contains(verbs, "*") {
			verbs = []string{"*"}
		}
		out[k] = verbs
	}

	return out
}

func (k grantKey) grant(verbs []string, kinds kindLookup) Grant {
	g := Grant{Group: k.group, Resource: k.resource, Verbs: verbs}
	if k.names != "" {
		g.ResourceNames = strings.Split(k.names, "\x00")
	}
	if kinds != nil {
		base, sub, _ := strings.Cut(k.resource, "/")
		if info, ok := kinds[k.group+"/"+base]; ok {
			g.Kind, g.ClusterScoped = info.kind, !info.namespaced
			if sub != "" {
				g.Kind += "/" + sub
			}
		}
	}

	return g
}

// clusterGrants turns the baseline into sorted rows.
func clusterGrants(baseline []atom, kinds kindLookup) []Grant {
	rows := collapse(baseline)
	out := make([]Grant, 0, len(rows))
	for k, verbs := range rows {
		out = append(out, k.grant(verbs, kinds))
	}
	sortGrants(out)

	return out
}

// namespacedGrants merges per-namespace extras: rows with identical verbs on
// the same resource share one row listing every namespace.
func namespacedGrants(extras map[string][]atom, kinds kindLookup) []Grant {
	type rowKey struct {
		grantKey
		verbs string
	}
	namespaces := map[rowKey][]string{}
	verbsOf := map[rowKey][]string{}
	for ns, in := range extras {
		for k, verbs := range collapse(in) {
			rk := rowKey{k, strings.Join(verbs, ",")}
			namespaces[rk] = append(namespaces[rk], ns)
			verbsOf[rk] = verbs
		}
	}
	out := make([]Grant, 0, len(namespaces))
	for rk, nss := range namespaces {
		slices.Sort(nss)
		g := rk.grant(verbsOf[rk], kinds)
		g.Namespaces = nss
		out = append(out, g)
	}
	sortGrants(out)

	return out
}

func sortGrants(gs []Grant) {
	slices.SortFunc(gs, func(a, b Grant) int {
		for _, c := range []int{
			strings.Compare(a.Group, b.Group),
			strings.Compare(a.Resource, b.Resource),
			strings.Compare(strings.Join(a.ResourceNames, ","), strings.Join(b.ResourceNames, ",")),
			strings.Compare(strings.Join(a.Namespaces, ","), strings.Join(b.Namespaces, ",")),
		} {
			if c != 0 {
				return c
			}
		}

		return 0
	})
}

func nonResourceGrants(rules []authorizationv1.NonResourceRule) []NonResourceGrant {
	byVerbs := map[string][]string{}
	for _, r := range rules {
		verbs := slices.Clone(r.Verbs)
		slices.Sort(verbs)
		k := strings.Join(verbs, ",")
		byVerbs[k] = append(byVerbs[k], r.NonResourceURLs...)
	}
	out := make([]NonResourceGrant, 0, len(byVerbs))
	for k, urls := range byVerbs {
		slices.Sort(urls)
		out = append(out, NonResourceGrant{URLs: slices.Compact(urls), Verbs: strings.Split(k, ",")})
	}
	slices.SortFunc(out, func(a, b NonResourceGrant) int {
		return strings.Compare(strings.Join(a.Verbs, ","), strings.Join(b.Verbs, ","))
	})

	return out
}
