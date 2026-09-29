// PURE. Namespace budget and network posture — the two things that decide
// whether a manifest that is perfectly valid will actually come up.

import { parseCount, parseCpuMillis, parseQuantity } from './quantity.js'
import type { NamespaceFact, NetworkPosture, PolicySelector, QuotaAmounts } from './types.js'

export type RawResourceQuota = {
  metadata?: { name?: string }
  // Prefer .status over .spec: status carries what the apiserver is actually
  // enforcing, including any defaults it filled in.
  status?: { hard?: QuotaAmounts; used?: QuotaAmounts }
  spec?: { hard?: QuotaAmounts }
}

export type RawLimitRange = {
  metadata?: { name?: string }
  spec?: { limits?: { type?: string; defaultRequest?: QuotaAmounts; default?: QuotaAmounts }[] }
}

export type RawSelector = {
  matchLabels?: Record<string, string>
  matchExpressions?: { key?: string; operator?: string; values?: string[] }[]
}

export type RawNetworkPolicy = {
  metadata?: { name?: string }
  spec?: {
    podSelector?: RawSelector
    policyTypes?: string[]
    ingress?: unknown[]
    egress?: unknown[]
  }
}

export type RawCiliumPolicy = {
  metadata?: { name?: string }
  spec?: {
    endpointSelector?: RawSelector
    ingress?: { fromEntities?: string[]; toPorts?: unknown[] }[]
    egress?: { toEntities?: string[]; toServices?: unknown[]; toPorts?: unknown[] }[]
  }
}

function selectsEverything(selector: RawSelector | undefined): boolean {
  if (!selector) return true

  const labels = Object.keys(selector.matchLabels ?? {}).length
  const expressions = (selector.matchExpressions ?? []).length

  return labels === 0 && expressions === 0
}

// Kubernetes defaults policyTypes to ["Ingress"], plus "Egress" when the policy
// carries egress rules. Reading the field blindly misses default-deny policies.
function effectiveTypes(spec: NonNullable<RawNetworkPolicy['spec']>): Set<string> {
  if (spec.policyTypes && spec.policyTypes.length > 0) return new Set(spec.policyTypes)

  const types = new Set(['Ingress'])

  if (spec.egress) types.add('Egress')

  return types
}

// "Default deny" is a policy that selects every pod, declares the direction,
// and permits nothing in it.
export function detectPosture(policies: RawNetworkPolicy[], direction: 'Ingress' | 'Egress'): NetworkPosture {
  for (const policy of policies) {
    const spec = policy.spec

    if (!spec) continue

    if (!effectiveTypes(spec).has(direction)) continue

    if (!selectsEverything(spec.podSelector)) continue

    const rules = direction === 'Ingress' ? spec.ingress : spec.egress

    if (!rules || rules.length === 0) return 'default-deny'
  }

  // Nothing denies everything in this direction. The unreadable case is the
  // caller's to report as "unknown"; here an empty list genuinely means open.
  return 'open'
}

function valueFor(
  selector: RawSelector | undefined,
  labelKey: string
): { present: boolean; value: string | null } {
  if (!selector) return { present: false, value: null }

  const exact = selector.matchLabels?.[labelKey]

  if (typeof exact === 'string') return { present: true, value: exact }

  for (const expression of selector.matchExpressions ?? []) {
    if (expression.key !== labelKey) continue

    // `Exists` matches every value, so such a policy covers any instance name.
    if (expression.operator === 'Exists') return { present: true, value: null }

    if (expression.operator === 'In' && expression.values?.length === 1) {
      return { present: true, value: expression.values[0] }
    }

    // In with several values, or NotIn: treat as present-but-unknown so the
    // caller does not claim coverage it cannot prove.
    return { present: true, value: null }
  }

  return { present: false, value: null }
}

// Which policies in this namespace key off an offering's own label, and whether
// they name one instance or any. The sandbox-stack bundle mixes both shapes:
// its cnpg ingress and Cilium policies hardcode `cnpg.io/cluster: database`,
// while the newer apiserver-egress policy uses `Exists` and so covers any name.
export function extractSelectors(
  labelKey: string,
  native: RawNetworkPolicy[],
  cilium: RawCiliumPolicy[]
): PolicySelector[] {
  const found: PolicySelector[] = []

  for (const policy of native) {
    const spec = policy.spec
    const name = policy.metadata?.name

    if (!spec || !name) continue

    const match = valueFor(spec.podSelector, labelKey)

    if (!match.present) continue

    for (const direction of effectiveTypes(spec)) {
      if (direction !== 'Ingress' && direction !== 'Egress') continue

      const rules = direction === 'Ingress' ? spec.ingress : spec.egress

      if (!rules || rules.length === 0) continue

      found.push({
        policy: name,
        kind: 'NetworkPolicy',
        direction,
        labelKey,
        labelValue: match.value,
        admits: `${rules.length} ${direction.toLowerCase()} rule(s) from pod or namespace selectors`
      })
    }
  }

  for (const policy of cilium) {
    const spec = policy.spec
    const name = policy.metadata?.name

    if (!spec || !name) continue

    const match = valueFor(spec.endpointSelector, labelKey)

    if (!match.present) continue

    for (const rule of spec.ingress ?? []) {
      found.push({
        policy: name,
        kind: 'CiliumNetworkPolicy',
        direction: 'Ingress',
        labelKey,
        labelValue: match.value,
        // Entity-based rules are the only way to admit node-sourced traffic,
        // which is exactly what CNPG's health probes are.
        admits: `ingress from entities ${(rule.fromEntities ?? []).join(', ') || '(none)'}`
      })
    }

    for (const rule of spec.egress ?? []) {
      found.push({
        policy: name,
        kind: 'CiliumNetworkPolicy',
        direction: 'Egress',
        labelKey,
        labelValue: match.value,
        admits: `egress to entities ${(rule.toEntities ?? []).join(', ') || '(services)'}`
      })
    }
  }

  return found
}

// Does any policy admit `direction` for an instance with this name? A selector
// with labelValue null is name-agnostic and therefore always counts.
export function coversInstance(
  selectors: PolicySelector[],
  instanceName: string,
  direction: 'Ingress' | 'Egress',
  predicate?: (selector: PolicySelector) => boolean
): boolean {
  return selectors.some(
    s =>
      s.direction === direction &&
      (s.labelValue === null || s.labelValue === instanceName) &&
      (predicate ? predicate(s) : true)
  )
}

export type Headroom = NonNullable<NamespaceFact['headroom']>

// hard minus used, per dimension. A dimension the quota does not mention is
// unlimited, which is null rather than 0 — the planner must not invent a cap.
export function computeHeadroom(quota: RawResourceQuota | null): Headroom | null {
  if (!quota) return null

  const hard = quota.status?.hard ?? quota.spec?.hard ?? {}
  const used = quota.status?.used ?? {}

  const remaining = (key: string, parse: (v?: string) => number | null): number | null => {
    const limit = parse(hard[key])

    if (limit === null) return null

    const consumed = parse(used[key]) ?? 0

    return Math.max(0, limit - consumed)
  }

  return {
    cpuMillis: remaining('requests.cpu', parseCpuMillis),
    memoryBytes: remaining('requests.memory', v => parseQuantity(v)),
    storageBytes: remaining('requests.storage', v => parseQuantity(v)),
    pvcCount: remaining('persistentvolumeclaims', parseCount),
    pods: remaining('pods', parseCount)
  }
}

// The container defaults a LimitRange injects when a manifest omits resources.
// On the sandbox stack that default is a 256Mi memory limit, which OOM-kills a
// PostgreSQL that ships without an explicit resources block.
export function containerDefaults(ranges: RawLimitRange[]): NamespaceFact['limitRange'] {
  for (const range of ranges) {
    for (const limit of range.spec?.limits ?? []) {
      if (limit.type !== 'Container') continue

      if (!limit.defaultRequest && !limit.default) continue

      return { defaultRequest: limit.defaultRequest ?? {}, default: limit.default ?? {} }
    }
  }

  return null
}
