// PURE. ValidatingAdmissionPolicies, which override RBAC: a caller whose role
// covers NetworkPolicies can still be refused by an enforced policy. Anything
// that answers "may I create this?" from RBAC alone errs in the optimistic
// direction, which is the dangerous one.
//
// We deliberately do NOT evaluate the CEL. It is not tractable from outside and
// a wrong verdict is worse than no verdict. Instead we report what a policy
// *guards* (from matchConstraints.resourceRules), surface its own `message`
// strings — which are written for humans and are exactly what a user needs —
// and check the binding, because a policy with no binding does nothing and one
// bound with only Audit/Warn does not block.

export type RawResourceRule = {
  apiGroups?: string[]
  apiVersions?: string[]
  operations?: string[]
  resources?: string[]
}

export type RawAdmissionPolicy = {
  metadata?: { name?: string; annotations?: Record<string, string> }
  spec?: {
    failurePolicy?: string
    paramKind?: { apiVersion?: string; kind?: string }
    matchConstraints?: { resourceRules?: RawResourceRule[]; matchPolicy?: string }
    matchConditions?: { name?: string; expression?: string }[]
    variables?: { name?: string; expression?: string }[]
    validations?: { expression?: string; message?: string; messageExpression?: string; reason?: string }[]
  }
}

export type RawAdmissionBinding = {
  metadata?: { name?: string }
  spec?: {
    policyName?: string
    // Absent means "no parameters"; present names the ConfigMap carrying them.
    paramRef?: { name?: string; namespace?: string }
    validationActions?: string[]
    matchResources?: {
      namespaceSelector?: {
        matchLabels?: Record<string, string>
        matchExpressions?: { key?: string; operator?: string; values?: string[] }[]
      }
      objectSelector?: { matchLabels?: Record<string, string> }
    }
  }
}

export type GuardedOperation = {
  group: string
  resource: string
  operations: string[]
  // The API versions a request must use to be matched. Absent means any: with
  // the default matchPolicy (Equivalent) Kubernetes converts a request into a
  // listed version and matches it, so only Exact narrows by version.
  versions?: string[]
}

export type AdmissionPolicyFact = {
  name: string
  // Deny actually blocks. A policy bound only for Audit or Warn does not, and
  // an unbound policy does nothing at all.
  enforced: boolean
  // Why it is or is not enforced, in the user's words.
  enforcement: string
  guards: GuardedOperation[]
  // The policy's own message strings: written for a human hitting the denial.
  messages: string[]
  // What the policy is for, from its kubernetes.io/description annotation.
  description: string | null
  // The labels a binding scopes on. Null means it applies everywhere.
  scopedToNamespaceLabels: Record<string, string> | null
  // Every namespace label key the denying binding's selector mentions, whether
  // by value (matchLabels) or by expression (Exists, In, ...).
  bindingLabelKeys: string[]
  // The namespaceSelector of every denying binding, as written ({} when a
  // binding has none, which selects every namespace). The policy governs a
  // namespace when any of them selects it.
  bindingSelectors: LabelSelector[]
  // Namespace label keys the policy's own CEL reads. Observed on real clusters:
  // bindings may carry no namespaceSelector at all and the tenant scoping lives
  // in the expressions, so without this a guard reads as governing every
  // namespace, including platform ones it actually exempts.
  scopedToNamespaceLabelKeys: string[]
  // Namespace names the policy's matchConditions confine it to (`only`) or
  // exclude (`except`), parsed from `request.namespace == 'x'`,
  // `request.namespace in [...]` and their negations. Without this a policy
  // that denies everything, but only in `default`, reads as denying every
  // create in every namespace.
  namespaceNames: { only: string[] | null; except: string[] }
  // Groups the policy's CEL exempts, parsed from `'x' in request.userInfo.groups`.
  // The real guards exempt by IDENTITY rather than by namespace, so without
  // this an admin is told they cannot do something they plainly can.
  exemptGroups: string[]
  // The ConfigMap a parameterised policy reads, so the caller knows to fetch it.
  paramRef: { name: string; namespace: string | null } | null
  // "constrains" when the policy shapes fields of an object you may create (a
  // name prefix, a size cap, an image source) rather than forbidding the
  // operation. The author can say so either way through the annotation below;
  // otherwise it is read from the CEL's shape (see effectOf).
  effect: 'denies' | 'constrains'
  // Namespace annotation keys the policy's CEL reads, e.g. a list of custom
  // domains the platform wrote onto the namespace. Noticed, not evaluated.
  namespaceAnnotationKeys: string[]
  // True when the CEL builds names from `request.namespace + ...`: hosts (or
  // other names) are anchored on the namespace itself rather than on a label.
  anchorsOnNamespace: boolean
}

// Optional, set by a policy author: `constrains` or `denies`. Overrides the
// inference in effectOf.
export const EFFECT_ANNOTATION = 'codemowers.io/admission-effect'

const OBJECT_REF = /\b(?:object|oldObject)\b/
const VARIABLE_REF = /\bvariables\.(\w+)/g

// Whether an expression reads the object under review, directly or through
// the policy's variables.
function readsObject(expression: string, variables: Map<string, string>, seen: Set<string> = new Set()): boolean {
  if (OBJECT_REF.test(expression)) return true

  for (const match of expression.matchAll(VARIABLE_REF)) {
    const name = match[1]
    const body = variables.get(name)

    if (body === undefined || seen.has(name)) continue

    seen.add(name)

    if (readsObject(body, variables, seen)) return true
  }

  return false
}

// Still not evaluating the CEL, only reading its shape. A validation that
// never looks at the object (`false`, or a test of the namespace or caller
// alone) decides whether the operation may happen at all. One that reads the
// object can be met by writing the object differently: a replica cap, an image
// source, a name prefix. A policy constrains only when every validation is of
// the second kind; anything else keeps denying, the conservative direction.
export function effectOf(policy: RawAdmissionPolicy): 'denies' | 'constrains' {
  const annotated = policy.metadata?.annotations?.[EFFECT_ANNOTATION]

  if (annotated === 'constrains' || annotated === 'denies') return annotated

  const validations = policy.spec?.validations ?? []
  const variables = new Map(
    (policy.spec?.variables ?? []).flatMap(v => (v.name ? [[v.name, v.expression ?? ''] as const] : []))
  )

  return validations.length > 0 && validations.every(v => readsObject(v.expression ?? '', variables))
    ? 'constrains'
    : 'denies'
}

function normaliseOperations(rule: RawResourceRule): string[] {
  const ops = rule.operations ?? []

  return ops.includes('*') ? ['CREATE', 'UPDATE', 'DELETE'] : ops
}

export function exactVersionsOf(rule: RawResourceRule, matchPolicy: string | undefined): string[] | undefined {
  const versions = rule.apiVersions ?? []

  return matchPolicy === 'Exact' && versions.length > 0 && !versions.includes('*') ? versions : undefined
}

function guardsOf(policy: RawAdmissionPolicy): GuardedOperation[] {
  const guarded: GuardedOperation[] = []
  const matchPolicy = policy.spec?.matchConstraints?.matchPolicy

  for (const rule of policy.spec?.matchConstraints?.resourceRules ?? []) {
    const operations = normaliseOperations(rule)
    const versions = exactVersionsOf(rule, matchPolicy)

    for (const group of rule.apiGroups ?? []) {
      for (const resource of rule.resources ?? []) {
        guarded.push(versions ? { group, resource, operations, versions } : { group, resource, operations })
      }
    }
  }

  return guarded
}

// Matches namespaceObject.metadata.labels['key'] and the ["key"] form. We are
// not evaluating the CEL — only noticing which namespace label it keys on,
// which is a checkable signal rather than a guess.
const NAMESPACE_LABEL_REF = /namespaceObject\.metadata\.labels\[\s*['"]([^'"]+)['"]\s*\]/g

function namespaceLabelKeysOf(policy: RawAdmissionPolicy): string[] {
  const expressions = [
    ...(policy.spec?.variables ?? []).map(v => v.expression ?? ''),
    ...(policy.spec?.validations ?? []).flatMap(v => [v.expression ?? '', v.messageExpression ?? ''])
  ]

  const keys = new Set<string>()

  for (const expression of expressions) {
    for (const match of expression.matchAll(NAMESPACE_LABEL_REF)) keys.add(match[1])
  }

  return [...keys]
}

const NAMESPACE_ANNOTATION_REF = /namespaceObject\.metadata\.annotations\[\s*['"]([^'"]+)['"]\s*\]|['"]([^'"]+)['"]\s*in\s+namespaceObject\.metadata\.annotations/g
const NAMESPACE_ANCHOR_REF = /request\.namespace\s*\+/

function expressionsOf(policy: RawAdmissionPolicy): string[] {
  return [
    ...(policy.spec?.variables ?? []).map(v => v.expression ?? ''),
    ...(policy.spec?.validations ?? []).flatMap(v => [v.expression ?? '', v.messageExpression ?? ''])
  ]
}

function namespaceAnnotationKeysOf(policy: RawAdmissionPolicy): string[] {
  const keys = new Set<string>()

  for (const expression of expressionsOf(policy)) {
    for (const match of expression.matchAll(NAMESPACE_ANNOTATION_REF)) keys.add(match[1] ?? match[2])
  }

  return [...keys]
}

function anchorsOnNamespace(policy: RawAdmissionPolicy): boolean {
  return expressionsOf(policy).some(expression => NAMESPACE_ANCHOR_REF.test(expression))
}

const QUOTED = /['"]([^'"]+)['"]/g
const NAME_EQ = /^(?:has\(request\.namespace\)\s*&&\s*)?request\.namespace\s*==\s*['"]([^'"]+)['"]$/
const NAME_NE = /^(?:has\(request\.namespace\)\s*&&\s*)?request\.namespace\s*!=\s*['"]([^'"]+)['"]$/
const NAME_IN = /^(?:has\(request\.namespace\)\s*&&\s*)?request\.namespace\s+in\s+\[([^\]]*)\]$/
const NAME_NOT_IN = /^!\s*\(\s*request\.namespace\s+in\s+\[([^\]]*)\]\s*\)$/

function quoted(list: string): string[] {
  return [...list.matchAll(QUOTED)].map(match => match[1])
}

// Each matchCondition must hold for the policy to apply at all, so a condition
// that is exactly a namespace-name test narrows where it applies. Anything
// more complex is left alone: under-reading scope only ever over-reports a
// denial, never hides one.
function namespaceNamesOf(policy: RawAdmissionPolicy): { only: string[] | null; except: string[] } {
  let only: string[] | null = null
  const except: string[] = []

  for (const condition of policy.spec?.matchConditions ?? []) {
    const expression = (condition.expression ?? '').trim()
    const eq = expression.match(NAME_EQ)?.[1]
    const inList = expression.match(NAME_IN)?.[1]
    const ne = expression.match(NAME_NE)?.[1]
    const notIn = expression.match(NAME_NOT_IN)?.[1]

    if (eq || inList !== undefined) {
      const names = eq ? [eq] : quoted(inList!)

      only = only ? only.filter(name => names.includes(name)) : names
    }

    if (ne) except.push(ne)

    if (notIn !== undefined) except.push(...quoted(notIn))
  }

  return { only, except: [...new Set(except)] }
}

// Matches `'group' in request.userInfo.groups`, the shape every guard here uses
// for its escape hatch.
const EXEMPT_GROUP_REF = /['"]([^'"]+)['"]\s*in\s+request\.userInfo\.groups/g

function exemptGroupsOf(policy: RawAdmissionPolicy): string[] {
  const expressions = [
    ...(policy.spec?.variables ?? []).map(v => v.expression ?? ''),
    ...(policy.spec?.validations ?? []).map(v => v.expression ?? '')
  ]
  const groups = new Set<string>()

  for (const expression of expressions) {
    for (const match of expression.matchAll(EXEMPT_GROUP_REF)) groups.add(match[1])
  }

  return [...groups]
}

function messagesOf(policy: RawAdmissionPolicy): string[] {
  const messages = (policy.spec?.validations ?? [])
    .map(v => v.message?.replace(/\s+/g, ' ').trim())
    .filter((m): m is string => Boolean(m))

  return [...new Set(messages)]
}

function descriptionOf(policy: RawAdmissionPolicy): string | null {
  return policy.metadata?.annotations?.['kubernetes.io/description']?.replace(/\s+/g, ' ').trim() || null
}

export function toAdmissionFacts(
  policies: RawAdmissionPolicy[],
  bindings: RawAdmissionBinding[]
): AdmissionPolicyFact[] {
  const facts: AdmissionPolicyFact[] = []

  for (const policy of policies) {
    const name = policy.metadata?.name

    if (!name) continue

    const bound = bindings.filter(b => b.spec?.policyName === name)
    // validationActions defaults to ["Deny"] when a binding omits it.
    const denying = bound.filter(b => (b.spec?.validationActions ?? ['Deny']).includes('Deny'))
    const enforced = denying.length > 0

    const enforcement = !bound.length
      ? 'This policy has no binding, so it is not in effect.'
      : enforced
        ? 'This policy denies matching requests.'
        : 'This policy only records matching requests; it will not block them.'

    const selector = denying[0]?.spec?.matchResources?.namespaceSelector
    const scoping = selector?.matchLabels ?? null
    const bindingLabelKeys = [
      ...new Set([
        ...Object.keys(scoping ?? {}),
        ...(selector?.matchExpressions ?? []).map(e => e.key).filter((k): k is string => Boolean(k))
      ])
    ]

    const paramName = denying[0]?.spec?.paramRef?.name ?? bound[0]?.spec?.paramRef?.name
    const paramNamespace =
      denying[0]?.spec?.paramRef?.namespace ?? bound[0]?.spec?.paramRef?.namespace ?? null

    facts.push({
      name,
      enforced,
      enforcement,
      guards: guardsOf(policy),
      messages: messagesOf(policy),
      description: descriptionOf(policy),
      scopedToNamespaceLabels: scoping && Object.keys(scoping).length > 0 ? scoping : null,
      bindingLabelKeys,
      bindingSelectors: denying.map(binding => binding.spec?.matchResources?.namespaceSelector ?? {}),
      scopedToNamespaceLabelKeys: namespaceLabelKeysOf(policy),
      namespaceNames: namespaceNamesOf(policy),
      exemptGroups: exemptGroupsOf(policy),
      paramRef: paramName ? { name: paramName, namespace: paramNamespace } : null,
      effect: effectOf(policy),
      namespaceAnnotationKeys: namespaceAnnotationKeysOf(policy),
      anchorsOnNamespace: anchorsOnNamespace(policy)
    })
  }

  return facts.sort((a, b) => Number(b.enforced) - Number(a.enforced) || a.name.localeCompare(b.name))
}

export type DenialCheck = {
  group: string
  resource: string
  operation: 'CREATE' | 'UPDATE' | 'DELETE'
  // The API version the request would use, when known. Without it a policy
  // confined to some versions is assumed to apply, the conservative reading.
  version?: string
  // Namespace labels, so a policy scoped to one kind of namespace is not
  // applied to a namespace that is not one.
  namespaceLabels: Record<string, string>
  // The caller's Kubernetes groups (as the apiserver sees them). Guards exempt
  // by identity, so an admin must not be told they cannot do something they can.
  callerGroups?: string[]
}

export type Denial = {
  policy: string
  // Every message the policy carries, not just the first. A guard often has
  // two, one about a specific case and one blanket rule, and only the second
  // explains a beginner's failure, so picking one arbitrarily loses the useful
  // half.
  messages: string[]
}

export type LabelSelector = {
  matchLabels?: Record<string, string>
  matchExpressions?: { key?: string; operator?: string; values?: string[] }[]
}

// Kubernetes label-selector semantics: every matchLabels pair and every
// expression must hold. An unknown operator selects nothing, which errs
// towards "this policy does not apply" only for selectors the API itself
// would have rejected.
export function selectorMatches(selector: LabelSelector, labels: Record<string, string>): boolean {
  const pairs = Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value)

  return (
    pairs &&
    (selector.matchExpressions ?? []).every(expression => {
      const key = expression.key ?? ''
      const present = Object.prototype.hasOwnProperty.call(labels, key)
      const values = expression.values ?? []

      switch (expression.operator) {
        case 'Exists':
          return present
        case 'DoesNotExist':
          return !present
        case 'In':
          return present && values.includes(labels[key])
        case 'NotIn':
          return !present || !values.includes(labels[key])
        default:
          return false
      }
    })
  )
}

function scopeApplies(fact: AdmissionPolicyFact, namespaceLabels: Record<string, string>): boolean {
  // The apiserver labels every namespace with its own name.
  const name = namespaceLabels['kubernetes.io/metadata.name']

  if (name && fact.namespaceNames) {
    if (fact.namespaceNames.only && !fact.namespaceNames.only.includes(name)) return false

    if (fact.namespaceNames.except.includes(name)) return false
  }

  // A binding selector is the explicit, authoritative scope: the policy
  // governs the namespace when any denying binding selects it.
  if (
    fact.bindingSelectors.length > 0 &&
    !fact.bindingSelectors.some(s => selectorMatches(s, namespaceLabels))
  ) {
    return false
  }

  // Failing that, a policy whose CEL reads a namespace label only governs
  // namespaces that carry it. Bindings observed in the wild have no selector,
  // so this is what stops a tenant guard reading as cluster-wide.
  if (fact.scopedToNamespaceLabelKeys.length > 0) {
    return fact.scopedToNamespaceLabelKeys.some(key => namespaceLabels[key] !== undefined)
  }

  return true
}

export function guardMatches(
  guard: GuardedOperation,
  check: Pick<DenialCheck, 'group' | 'resource' | 'operation' | 'version'>
): boolean {
  const groupMatches = guard.group === '*' || guard.group === check.group
  const resourceMatches = guard.resource === '*' || guard.resource === check.resource
  const versionMatches = !guard.versions || !check.version || guard.versions.includes(check.version)

  return groupMatches && resourceMatches && versionMatches && guard.operations.includes(check.operation)
}

// Which enforced policies stand between the caller and this operation. Because
// the CEL is not evaluated, a denial means "an admission policy governs this and
// may reject it", never "this is definitely allowed" — so callers must treat a
// denial as a reason to stop, and a miss as no information either way.
// Constraints govern what the object looks like, not whether it may exist:
// they are requirements to meet, reported beside an allowing verdict.
export function admissionFor(
  facts: AdmissionPolicyFact[],
  check: DenialCheck
): { denials: Denial[]; constraints: Denial[] } {
  const denials: Denial[] = []
  const constraints: Denial[] = []

  for (const fact of facts) {
    if (!fact.enforced) continue

    if (!scopeApplies(fact, check.namespaceLabels)) continue

    if (!fact.guards.some(guard => guardMatches(guard, check))) continue

    // Identity exemption: guards commonly let admin groups through, and telling
    // such a caller they are blocked would be wrong.
    if (fact.exemptGroups.some(group => check.callerGroups?.includes(group))) continue

    const bucket = fact.effect === 'constrains' ? constraints : denials

    bucket.push({
      policy: fact.name,
      messages:
        fact.messages.length > 0
          ? fact.messages
          : [`The ${fact.name} admission policy governs ${check.operation} on ${check.resource}.`]
    })
  }

  return { denials, constraints }
}

export function denialsFor(facts: AdmissionPolicyFact[], check: DenialCheck): Denial[] {
  return admissionFor(facts, check).denials
}

// The namespace label an enforced guard keys its tenancy on, discovered from
// the policies themselves rather than configured. The ingress guard is the
// best witness (its scoping is what host rules depend on); any other enforced
// guard that scopes on a label is the fallback. Null on a cluster whose
// policies scope on nothing, which is the honest answer there.
export function tenantLabelKeyFor(facts: AdmissionPolicyFact[]): string | null {
  const keysOf = (fact: AdmissionPolicyFact) => [...fact.bindingLabelKeys, ...fact.scopedToNamespaceLabelKeys]
  const enforced = facts.filter(fact => fact.enforced)
  const ingressGuard = enforced.find(fact =>
    fact.guards.some(g => g.resource === 'ingresses' && g.operations.includes('CREATE'))
  )

  for (const candidate of [ingressGuard, ...enforced]) {
    const key = candidate ? keysOf(candidate)[0] : undefined

    if (key) return key
  }

  return null
}

// The projection a client sees: the pointer to a parameter ConfigMap and the
// CEL-derived scoping are followed server-side and are of no use downstream.
export function toAdmissionFact(fact: AdmissionPolicyFact): {
  name: string
  enforced: boolean
  enforcement: string
  guards: GuardedOperation[]
  messages: string[]
  description: string | null
  scopedToNamespaceLabels: Record<string, string> | null
} {
  return {
    name: fact.name,
    enforced: fact.enforced,
    enforcement: fact.enforcement,
    guards: fact.guards,
    messages: fact.messages,
    description: fact.description,
    scopedToNamespaceLabels: fact.scopedToNamespaceLabels
  }
}
