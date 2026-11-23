package provisioning

import (
	"regexp"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/nonnil"
)

// ValidatingAdmissionPolicies override RBAC: a caller whose role covers
// NetworkPolicies can still be refused by an enforced policy, so anything
// that answers "may I create this?" from RBAC alone errs in the optimistic
// direction, which is the dangerous one.
//
// The CEL is deliberately not evaluated. It is not tractable from outside and a
// wrong verdict is worse than none. Instead a policy reports what it guards
// (matchConstraints.resourceRules), its own human-written messages, and its
// binding, because an unbound policy does nothing and one bound only for Audit
// or Warn does not block. Scope and exemptions are read from the shape of the
// expressions, never by evaluating them.

type ResourceRule struct {
	APIGroups   []string `json:"apiGroups,omitempty"`
	APIVersions []string `json:"apiVersions,omitempty"`
	Operations  []string `json:"operations,omitempty"`
	Resources   []string `json:"resources,omitempty"`
}

type Expression struct {
	Name              string `json:"name,omitempty"`
	Expression        string `json:"expression,omitempty"`
	Message           string `json:"message,omitempty"`
	MessageExpression string `json:"messageExpression,omitempty"`
}

type AdmissionPolicy struct {
	Name            string
	Annotations     map[string]string
	MatchPolicy     string
	ResourceRules   []ResourceRule
	MatchConditions []Expression
	Variables       []Expression
	Validations     []Expression
}

type LabelSelectorRequirement struct {
	Key      string   `json:"key"`
	Operator string   `json:"operator"`
	Values   []string `json:"values,omitempty"`
}

type LabelSelector struct {
	MatchLabels      map[string]string          `json:"matchLabels,omitempty"`
	MatchExpressions []LabelSelectorRequirement `json:"matchExpressions,omitempty"`
}

func (s *LabelSelector) selectsSomething() bool {
	return s != nil && (len(s.MatchLabels) > 0 || len(s.MatchExpressions) > 0)
}

type AdmissionBinding struct {
	PolicyName string
	// Nil means validationActions was omitted, which defaults to Deny.
	ValidationActions []string
	// Nil when the binding has no namespaceSelector.
	NamespaceSelector *LabelSelector
	ParamRefName      string
	ParamRefNamespace string
}

type GuardedOperation struct {
	Group      string   `json:"group"`
	Resource   string   `json:"resource"`
	Operations []string `json:"operations"`
	// The API versions a request must use to be matched. Absent means any:
	// with the default matchPolicy (Equivalent) a request is converted into a
	// listed version, so only Exact narrows by version.
	Versions []string `json:"versions,omitempty"`
}

type NamespaceNames struct {
	// Nil when the policy is not confined to named namespaces.
	Only   []string
	Except []string
}

type ParamRef struct {
	Name      string  `json:"name"`
	Namespace *string `json:"namespace"`
}

// AdmissionPolicyFact is everything this server derives from a policy and its
// bindings.
type AdmissionPolicyFact struct {
	Name string
	// Deny actually blocks; Audit or Warn does not, and unbound does nothing.
	Enforced    bool
	Enforcement string
	Guards      []GuardedOperation
	// The policy's own messages: written for a human hitting the denial.
	Messages []string
	// From the kubernetes.io/description annotation.
	Description *string
	// The labels the denying binding scopes on; nil applies everywhere.
	ScopedToNamespaceLabels map[string]string
	// Every namespace label key the denying binding's selector mentions.
	BindingLabelKeys []string
	// The namespaceSelector of every denying binding ({} when it has none,
	// which selects every namespace).
	BindingSelectors []LabelSelector
	// Namespace label keys the CEL reads. Bindings observed in the wild carry
	// no selector and scope in the expressions instead.
	ScopedToNamespaceLabelKeys []string
	// Namespace names matchConditions confine the policy to or exclude.
	NamespaceNames NamespaceNames
	// Groups the CEL exempts, from `'x' in request.userInfo.groups`. Guards
	// exempt by identity, so an admin must not be told they cannot do
	// something they plainly can.
	ExemptGroups []string
	// The ConfigMap a parameterised policy reads.
	ParamRef *ParamRef
	// "constrains" when the policy shapes fields of an object you may create
	// rather than forbidding the operation.
	Effect string
	// Namespace annotation keys the CEL reads, e.g. verified custom domains.
	NamespaceAnnotationKeys []string
	// True when the CEL builds names from `request.namespace + ...`.
	AnchorsOnNamespace bool
}

// EffectAnnotation lets a policy author declare `constrains` or `denies`,
// overriding the inference in effectOf.
const EffectAnnotation = "codemowers.io/admission-effect"

var (
	objectRef             = regexp.MustCompile(`\b(?:object|oldObject)\b`)
	variableRef           = regexp.MustCompile(`\bvariables\.(\w+)`)
	namespaceLabelRef     = regexp.MustCompile(`namespaceObject\.metadata\.labels\[\s*['"]([^'"]+)['"]\s*\]`)
	namespaceAnnotationRf = regexp.MustCompile(`namespaceObject\.metadata\.annotations\[\s*['"]([^'"]+)['"]\s*\]|['"]([^'"]+)['"]\s*in\s+namespaceObject\.metadata\.annotations`)
	namespaceAnchorRef    = regexp.MustCompile(`request\.namespace\s*\+`)
	quotedRef             = regexp.MustCompile(`['"]([^'"]+)['"]`)
	nameEq                = regexp.MustCompile(`^(?:has\(request\.namespace\)\s*&&\s*)?request\.namespace\s*==\s*['"]([^'"]+)['"]$`)
	nameNe                = regexp.MustCompile(`^(?:has\(request\.namespace\)\s*&&\s*)?request\.namespace\s*!=\s*['"]([^'"]+)['"]$`)
	nameIn                = regexp.MustCompile(`^(?:has\(request\.namespace\)\s*&&\s*)?request\.namespace\s+in\s+\[([^\]]*)\]$`)
	nameNotIn             = regexp.MustCompile(`^!\s*\(\s*request\.namespace\s+in\s+\[([^\]]*)\]\s*\)$`)
	exemptGroupRef        = regexp.MustCompile(`['"]([^'"]+)['"]\s*in\s+request\.userInfo\.groups`)
)

// readsObject reports whether an expression reads the object under review,
// directly or through the policy's variables.
func readsObject(expression string, variables map[string]string, seen map[string]bool) bool {
	if objectRef.MatchString(expression) {
		return true
	}
	for _, m := range variableRef.FindAllStringSubmatch(expression, -1) {
		body, ok := variables[m[1]]
		if !ok || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		if readsObject(body, variables, seen) {
			return true
		}
	}

	return false
}

// effectOf reads the CEL's shape, still without evaluating it. A validation
// that never looks at the object decides whether the operation may happen at
// all; one that reads the object can be met by writing the object
// differently. A policy constrains only when every validation is of the second
// kind; anything else keeps denying, the conservative direction.
func effectOf(p AdmissionPolicy) string {
	if a := p.Annotations[EffectAnnotation]; a == "constrains" || a == "denies" {
		return a
	}
	variables := map[string]string{}
	for _, v := range p.Variables {
		if v.Name != "" {
			variables[v.Name] = v.Expression
		}
	}
	if len(p.Validations) == 0 {
		return "denies"
	}
	for _, v := range p.Validations {
		if !readsObject(v.Expression, variables, map[string]bool{}) {
			return "denies"
		}
	}

	return "constrains"
}

func normaliseOperations(ops []string) []string {
	if slices.Contains(ops, "*") {
		return []string{"CREATE", "UPDATE", "DELETE"}
	}
	if ops == nil {
		return []string{}
	}

	return ops
}

func exactVersionsOf(rule ResourceRule, matchPolicy string) []string {
	if matchPolicy == "Exact" && len(rule.APIVersions) > 0 && !slices.Contains(rule.APIVersions, "*") {
		return rule.APIVersions
	}

	return nil
}

func guardsOf(rules []ResourceRule, matchPolicy string) []GuardedOperation {
	guards := []GuardedOperation{}
	for _, rule := range rules {
		ops := normaliseOperations(rule.Operations)
		versions := exactVersionsOf(rule, matchPolicy)
		for _, group := range rule.APIGroups {
			for _, resource := range rule.Resources {
				guards = append(guards, GuardedOperation{Group: group, Resource: resource, Operations: ops, Versions: versions})
			}
		}
	}

	return guards
}

func expressionsOf(p AdmissionPolicy) []string {
	var out []string
	for _, v := range p.Variables {
		out = append(out, v.Expression)
	}
	for _, v := range p.Validations {
		out = append(out, v.Expression, v.MessageExpression)
	}

	return out
}

func captures(re *regexp.Regexp, expressions []string) []string {
	var keys []string
	for _, e := range expressions {
		for _, m := range re.FindAllStringSubmatch(e, -1) {
			for _, g := range m[1:] {
				if g != "" {
					keys = append(keys, g)

					break
				}
			}
		}
	}

	return unique(keys)
}

func quotedItems(list string) []string {
	var out []string
	for _, m := range quotedRef.FindAllStringSubmatch(list, -1) {
		out = append(out, m[1])
	}

	return out
}

// namespaceNamesOf reads matchConditions that are exactly a namespace-name
// test. Anything more complex is left alone: under-reading scope only ever
// over-reports a denial, never hides one.
func namespaceNamesOf(p AdmissionPolicy) NamespaceNames {
	var only []string
	confined := false
	except := []string{}
	for _, c := range p.MatchConditions {
		e := strings.TrimSpace(c.Expression)
		var names []string
		matched := false
		if m := nameEq.FindStringSubmatch(e); m != nil {
			names, matched = []string{m[1]}, true
		} else if m := nameIn.FindStringSubmatch(e); m != nil {
			names, matched = quotedItems(m[1]), true
		}
		if matched {
			if confined {
				only = slices.DeleteFunc(only, func(n string) bool { return !slices.Contains(names, n) })
			} else {
				only, confined = names, true
			}
		}
		if m := nameNe.FindStringSubmatch(e); m != nil {
			except = append(except, m[1])
		}
		if m := nameNotIn.FindStringSubmatch(e); m != nil {
			except = append(except, quotedItems(m[1])...)
		}
	}
	if confined && only == nil {
		only = []string{}
	}

	return NamespaceNames{Only: only, Except: unique(except)}
}

func exemptGroupsOf(p AdmissionPolicy) []string {
	var expressions []string
	for _, v := range p.Variables {
		expressions = append(expressions, v.Expression)
	}
	for _, v := range p.Validations {
		expressions = append(expressions, v.Expression)
	}

	return captures(exemptGroupRef, expressions)
}

func messagesOf(p AdmissionPolicy) []string {
	var out []string
	for _, v := range p.Validations {
		if m := foldSpace(v.Message); m != "" {
			out = append(out, m)
		}
	}

	return unique(out)
}

// ToAdmissionFacts derives facts for every named policy, enforced ones first.
func ToAdmissionFacts(policies []AdmissionPolicy, bindings []AdmissionBinding) []AdmissionPolicyFact {
	facts := []AdmissionPolicyFact{}
	for _, p := range policies {
		if p.Name == "" {
			continue
		}
		var bound, denying []AdmissionBinding
		for _, b := range bindings {
			if b.PolicyName != p.Name {
				continue
			}
			bound = append(bound, b)
			if b.ValidationActions == nil || slices.Contains(b.ValidationActions, "Deny") {
				denying = append(denying, b)
			}
		}
		enforced := len(denying) > 0
		enforcement := "This policy only records matching requests; it will not block them."
		switch {
		case len(bound) == 0:
			enforcement = "This policy has no binding, so it is not in effect."
		case enforced:
			enforcement = "This policy denies matching requests."
		}

		var selector *LabelSelector
		if enforced {
			selector = denying[0].NamespaceSelector
		}
		var scoping map[string]string
		labelKeys := []string{}
		if selector != nil {
			scoping = selector.MatchLabels
			for k := range selector.MatchLabels {
				labelKeys = append(labelKeys, k)
			}
			slices.Sort(labelKeys)
			for _, e := range selector.MatchExpressions {
				if e.Key != "" {
					labelKeys = append(labelKeys, e.Key)
				}
			}
			labelKeys = unique(labelKeys)
		}
		if len(scoping) == 0 {
			scoping = nil
		}

		selectors := []LabelSelector{}
		for _, b := range denying {
			if b.NamespaceSelector != nil {
				selectors = append(selectors, *b.NamespaceSelector)
			} else {
				selectors = append(selectors, LabelSelector{})
			}
		}

		var paramRef *ParamRef
		var ref *AdmissionBinding
		if enforced && denying[0].ParamRefName != "" {
			ref = &denying[0]
		} else if len(bound) > 0 && bound[0].ParamRefName != "" {
			ref = &bound[0]
		}
		if ref != nil {
			paramRef = &ParamRef{Name: ref.ParamRefName, Namespace: nonnil.String(ref.ParamRefNamespace)}
		}

		facts = append(facts, AdmissionPolicyFact{
			Name:                       p.Name,
			Enforced:                   enforced,
			Enforcement:                enforcement,
			Guards:                     guardsOf(p.ResourceRules, p.MatchPolicy),
			Messages:                   messagesOf(p),
			Description:                nonnil.String(foldSpace(p.Annotations["kubernetes.io/description"])),
			ScopedToNamespaceLabels:    scoping,
			BindingLabelKeys:           labelKeys,
			BindingSelectors:           selectors,
			ScopedToNamespaceLabelKeys: captures(namespaceLabelRef, expressionsOf(p)),
			NamespaceNames:             namespaceNamesOf(p),
			ExemptGroups:               exemptGroupsOf(p),
			ParamRef:                   paramRef,
			Effect:                     effectOf(p),
			NamespaceAnnotationKeys:    captures(namespaceAnnotationRf, expressionsOf(p)),
			AnchorsOnNamespace:         slices.ContainsFunc(expressionsOf(p), namespaceAnchorRef.MatchString),
		})
	}
	slices.SortStableFunc(facts, func(a, b AdmissionPolicyFact) int {
		if a.Enforced != b.Enforced {
			if a.Enforced {
				return -1
			}

			return 1
		}

		return localeCompare(a.Name, b.Name)
	})

	return facts
}

// SelectorMatches applies Kubernetes label-selector semantics. An unknown
// operator selects nothing.
func SelectorMatches(s LabelSelector, labels map[string]string) bool {
	for k, v := range s.MatchLabels {
		if actual, ok := labels[k]; !ok || actual != v {
			return false
		}
	}
	for _, e := range s.MatchExpressions {
		value, present := labels[e.Key]
		var ok bool
		switch e.Operator {
		case "Exists":
			ok = present
		case "DoesNotExist":
			ok = !present
		case "In":
			ok = present && slices.Contains(e.Values, value)
		case "NotIn":
			ok = !present || !slices.Contains(e.Values, value)
		}
		if !ok {
			return false
		}
	}

	return true
}

func scopeApplies(f AdmissionPolicyFact, labels map[string]string) bool {
	if name := labels["kubernetes.io/metadata.name"]; name != "" {
		if f.NamespaceNames.Only != nil && !slices.Contains(f.NamespaceNames.Only, name) {
			return false
		}
		if slices.Contains(f.NamespaceNames.Except, name) {
			return false
		}
	}
	// A binding selector is the authoritative scope: the policy governs the
	// namespace when any denying binding selects it.
	if len(f.BindingSelectors) > 0 && !slices.ContainsFunc(f.BindingSelectors, func(s LabelSelector) bool {
		return SelectorMatches(s, labels)
	}) {
		return false
	}
	// Failing that, a policy whose CEL reads a namespace label governs only
	// namespaces that carry it.
	if len(f.ScopedToNamespaceLabelKeys) > 0 {
		return slices.ContainsFunc(f.ScopedToNamespaceLabelKeys, func(k string) bool {
			_, ok := labels[k]

			return ok
		})
	}

	return true
}

type Operation struct {
	Group     string
	Resource  string
	Operation string
	// The API version the request would use, when known. Without it a policy
	// confined to some versions is assumed to apply, the conservative reading.
	Version string
}

func guardMatches(g GuardedOperation, op Operation) bool {
	return (g.Group == "*" || g.Group == op.Group) &&
		(g.Resource == "*" || g.Resource == op.Resource) &&
		(g.Versions == nil || op.Version == "" || slices.Contains(g.Versions, op.Version)) &&
		slices.Contains(g.Operations, op.Operation)
}

// DenialCheck asks which enforced policies govern an operation in a namespace
// for a caller.
type DenialCheck struct {
	Operation
	NamespaceLabels map[string]string
	CallerGroups    []string
}

type Denial struct {
	Policy string `json:"policy"`
	// Every message the policy carries: a guard often has a specific rule and a
	// blanket one, and only the second explains a beginner's failure.
	Messages []string `json:"messages"`
}

// AdmissionFor returns which enforced policies stand between the caller and
// the operation. A denial means "an admission policy governs this and may
// reject it", never "this is definitely allowed", so a denial is a reason to
// stop and a miss is no information. Constraints govern what the object
// looks like, not whether it may exist.
func AdmissionFor(facts []AdmissionPolicyFact, check DenialCheck) (denials, constraints []Denial) {
	denials, constraints = []Denial{}, []Denial{}
	for _, f := range facts {
		if !f.Enforced || !scopeApplies(f, check.NamespaceLabels) {
			continue
		}
		if !slices.ContainsFunc(f.Guards, func(g GuardedOperation) bool { return guardMatches(g, check.Operation) }) {
			continue
		}
		if slices.ContainsFunc(f.ExemptGroups, func(g string) bool { return slices.Contains(check.CallerGroups, g) }) {
			continue
		}
		messages := f.Messages
		if len(messages) == 0 {
			messages = []string{"The " + f.Name + " admission policy governs " + check.Operation.Operation + " on " + check.Resource + "."}
		}
		d := Denial{Policy: f.Name, Messages: messages}
		if f.Effect == "constrains" {
			constraints = append(constraints, d)
		} else {
			denials = append(denials, d)
		}
	}

	return denials, constraints
}

// TenantLabelKeyFor finds the namespace label an enforced guard keys tenancy
// on, from the policies themselves. The ingress guard is the best witness;
// any other enforced guard that scopes on a label is the fallback.
func TenantLabelKeyFor(facts []AdmissionPolicyFact) string {
	var enforced []AdmissionPolicyFact
	for _, f := range facts {
		if f.Enforced {
			enforced = append(enforced, f)
		}
	}
	keyOf := func(f AdmissionPolicyFact) string {
		if keys := append(slices.Clone(f.BindingLabelKeys), f.ScopedToNamespaceLabelKeys...); len(keys) > 0 {
			return keys[0]
		}

		return ""
	}
	for _, f := range enforced {
		if slices.ContainsFunc(f.Guards, func(g GuardedOperation) bool {
			return g.Resource == "ingresses" && slices.Contains(g.Operations, "CREATE")
		}) {
			if k := keyOf(f); k != "" {
				return k
			}

			break
		}
	}
	for _, f := range enforced {
		if k := keyOf(f); k != "" {
			return k
		}
	}

	return ""
}

// Projection is what a client sees; the parameter ConfigMap and CEL-derived
// scoping are followed server-side.
func (f AdmissionPolicyFact) Projection() AdmissionFact {
	return AdmissionFact{
		Name:                    f.Name,
		Enforced:                f.Enforced,
		Enforcement:             f.Enforcement,
		Guards:                  f.Guards,
		Messages:                nonnil.Slice(f.Messages),
		Description:             f.Description,
		ScopedToNamespaceLabels: f.ScopedToNamespaceLabels,
	}
}
