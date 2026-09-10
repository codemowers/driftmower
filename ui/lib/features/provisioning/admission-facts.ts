// PURE. ValidatingAdmissionPolicies, which are the real gate on these clusters
// — and which override RBAC. A sandbox owner holds the namespaced `admin` role,
// so RBAC says they may create a NetworkPolicy; `sandbox-egress-guard` denies
// it anyway. Anything that answers "may I create this?" from RBAC alone errs
// in the optimistic direction, which is the dangerous one.
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
  metadata?: { name?: string }
  spec?: {
    failurePolicy?: string
    paramKind?: { apiVersion?: string; kind?: string }
    matchConstraints?: { resourceRules?: RawResourceRule[] }
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
      namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] }
      objectSelector?: { matchLabels?: Record<string, string> }
    }
  }
}

export type GuardedOperation = {
  group: string
  resource: string
  operations: string[]
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
  // The label a binding scopes on, e.g. codemowers.io/sandbox. Null means it
  // applies everywhere.
  scopedToNamespaceLabels: Record<string, string> | null
  // The ConfigMap a parameterised policy reads, so the caller knows to fetch it.
  paramRef: { name: string; namespace: string | null } | null
}

function normaliseOperations(rule: RawResourceRule): string[] {
  const ops = rule.operations ?? []
  return ops.includes("*") ? ["CREATE", "UPDATE", "DELETE"] : ops
}

function guardsOf(policy: RawAdmissionPolicy): GuardedOperation[] {
  const guarded: GuardedOperation[] = []
  for (const rule of policy.spec?.matchConstraints?.resourceRules ?? []) {
    const operations = normaliseOperations(rule)
    for (const group of rule.apiGroups ?? []) {
      for (const resource of rule.resources ?? []) {
        guarded.push({ group, resource, operations })
      }
    }
  }
  return guarded
}

function messagesOf(policy: RawAdmissionPolicy): string[] {
  const messages = (policy.spec?.validations ?? [])
    .map(v => v.message?.replace(/\s+/g, " ").trim())
    .filter((m): m is string => Boolean(m))
  return [...new Set(messages)]
}

export function toAdmissionFacts(
  policies: RawAdmissionPolicy[],
  bindings: RawAdmissionBinding[],
): AdmissionPolicyFact[] {
  const facts: AdmissionPolicyFact[] = []

  for (const policy of policies) {
    const name = policy.metadata?.name
    if (!name) continue

    const bound = bindings.filter(b => b.spec?.policyName === name)
    // validationActions defaults to ["Deny"] when a binding omits it.
    const denying = bound.filter(b => (b.spec?.validationActions ?? ["Deny"]).includes("Deny"))
    const enforced = denying.length > 0

    const enforcement = !bound.length
      ? "This policy has no binding, so it is not in effect."
      : enforced
        ? "This policy denies matching requests."
        : "This policy only records matching requests; it will not block them."

    const scoping = denying[0]?.spec?.matchResources?.namespaceSelector?.matchLabels ?? null

    const paramName = denying[0]?.spec?.paramRef?.name ?? bound[0]?.spec?.paramRef?.name
    const paramNamespace = denying[0]?.spec?.paramRef?.namespace ?? bound[0]?.spec?.paramRef?.namespace ?? null

    facts.push({
      name,
      enforced,
      enforcement,
      guards: guardsOf(policy),
      messages: messagesOf(policy),
      scopedToNamespaceLabels: scoping && Object.keys(scoping).length > 0 ? scoping : null,
      paramRef: paramName ? { name: paramName, namespace: paramNamespace } : null,
    })
  }

  return facts.sort((a, b) => Number(b.enforced) - Number(a.enforced) || a.name.localeCompare(b.name))
}

export type DenialCheck = {
  group: string
  resource: string
  operation: "CREATE" | "UPDATE" | "DELETE"
  // Namespace labels, so a policy scoped to sandboxes is not applied to a
  // namespace that is not one.
  namespaceLabels: Record<string, string>
}

export type Denial = { policy: string; message: string }

function scopeApplies(fact: AdmissionPolicyFact, namespaceLabels: Record<string, string>): boolean {
  if (!fact.scopedToNamespaceLabels) return true
  return Object.entries(fact.scopedToNamespaceLabels).every(([key, value]) => namespaceLabels[key] === value)
}

function guardMatches(guard: GuardedOperation, check: DenialCheck): boolean {
  const groupMatches = guard.group === "*" || guard.group === check.group
  const resourceMatches = guard.resource === "*" || guard.resource === check.resource
  return groupMatches && resourceMatches && guard.operations.includes(check.operation)
}

// Which enforced policies stand between the caller and this operation. Because
// the CEL is not evaluated, a hit means "an admission policy governs this and
// may reject it", never "this is definitely allowed" — so callers must treat a
// hit as a reason to stop, and a miss as no information either way.
export function denialsFor(facts: AdmissionPolicyFact[], check: DenialCheck): Denial[] {
  const denials: Denial[] = []

  for (const fact of facts) {
    if (!fact.enforced) continue
    if (!scopeApplies(fact, check.namespaceLabels)) continue
    if (!fact.guards.some(guard => guardMatches(guard, check))) continue

    denials.push({
      policy: fact.name,
      message: fact.messages[0] ?? `The ${fact.name} admission policy governs ${check.operation} on ${check.resource}.`,
    })
  }

  return denials
}
