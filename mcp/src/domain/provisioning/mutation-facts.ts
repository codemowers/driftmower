// PURE. MutatingAdmissionPolicies rewrite an object on its way in, so what the
// cluster stores is not what the caller applied. A default that points at
// something which must already exist (a Secret, a class) turns a manifest
// that looks complete into one that stalls after admission, and nothing in the
// caller's own manifest says why.
//
// As with validating policies, the CEL is not evaluated. A policy reports what
// it mutates (from matchConstraints.resourceRules) and its author's own
// kubernetes.io/description, which is the only trustworthy account of what the
// mutation does and what it requires.

import type { ProvisionTarget } from './access-facts.js'
import { guardMatches, type GuardedOperation, type LabelSelector, type RawResourceRule } from './admission-facts.js'

export type RawMutatingPolicy = {
  metadata?: { name?: string }
  description?: string | null
  spec?: { matchConstraints?: { resourceRules?: RawResourceRule[]; namespaceSelector?: LabelSelector } }
}

export type RawMutatingBinding = {
  spec?: { policyName?: string; matchResources?: { namespaceSelector?: LabelSelector } }
}

export type MutationFact = {
  name: string
  description: string | null
  guards: GuardedOperation[]
  // True when the policy or a binding narrows it to selected namespaces, so it
  // may not apply in the caller's.
  namespaceScoped: boolean
}

// What an offering's resources become on create, per policy.
export type AdmissionDefault = {
  policy: string
  // "clusters.postgresql.cnpg.io"
  resource: string
  description: string | null
  namespaceScoped: boolean
}

function selects(selector: LabelSelector | undefined): boolean {
  return Boolean(
    selector &&
      (Object.keys(selector.matchLabels ?? {}).length > 0 || (selector.matchExpressions ?? []).length > 0)
  )
}

function guardsOf(policy: RawMutatingPolicy): GuardedOperation[] {
  return (policy.spec?.matchConstraints?.resourceRules ?? []).flatMap(rule => {
    const operations = (rule.operations ?? []).includes('*')
      ? ['CREATE', 'UPDATE', 'DELETE']
      : (rule.operations ?? [])

    return (rule.apiGroups ?? []).flatMap(group =>
      (rule.resources ?? []).map(resource => ({ group, resource, operations }))
    )
  })
}

// Only bound policies: a MutatingAdmissionPolicy without a binding does nothing.
export function toMutationFacts(policies: RawMutatingPolicy[], bindings: RawMutatingBinding[]): MutationFact[] {
  const facts: MutationFact[] = []

  for (const policy of policies) {
    const name = policy.metadata?.name

    if (!name) continue

    const bound = bindings.filter(binding => binding.spec?.policyName === name)

    if (bound.length === 0) continue

    facts.push({
      name,
      description: policy.description?.replace(/\s+/g, ' ').trim() || null,
      guards: guardsOf(policy),
      namespaceScoped:
        selects(policy.spec?.matchConstraints?.namespaceSelector) ||
        bound.every(binding => selects(binding.spec?.matchResources?.namespaceSelector))
    })
  }

  return facts.sort((a, b) => a.name.localeCompare(b.name))
}

// Every bound policy that rewrites this operation on this resource.
export function mutationsOf(
  facts: MutationFact[],
  check: { group: string; resource: string; operation: 'CREATE' | 'UPDATE' }
): AdmissionDefault[] {
  return facts
    .filter(fact => fact.guards.some(guard => guardMatches(guard, check)))
    .map(fact => ({
      policy: fact.name,
      resource: `${check.resource}.${check.group || 'core'}`,
      description: fact.description,
      namespaceScoped: fact.namespaceScoped
    }))
}

export function defaultsFor(facts: MutationFact[], target: ProvisionTarget): AdmissionDefault[] {
  return target.resources.flatMap(({ group, resource }) =>
    resource ? mutationsOf(facts, { group, resource, operation: 'CREATE' }) : []
  )
}
