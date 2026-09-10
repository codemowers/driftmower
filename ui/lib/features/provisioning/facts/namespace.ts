import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { mayCreate, type RawRoleBinding, type ResolvedRole } from "../authz-heuristic"
import {
  computeHeadroom,
  containerDefaults,
  detectPosture,
  extractSelectors,
  type RawCiliumPolicy,
  type RawLimitRange,
  type RawNetworkPolicy,
  type RawResourceQuota,
} from "../namespace-facts"
import type { DegradedRead, NamespaceFact, PolicySelector } from "../types"
import { optional } from "./tolerate"

// Per-namespace facts are deliberately NOT cached: quota headroom and name
// collisions must be fresh, or the planner green-lights a plan that the
// apiserver has just started rejecting. It is six small GETs.

const ns = (namespace: string) => encodeURIComponent(namespace)

type RawNamespace = { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } }

export type NamespaceFactsInput = {
  namespace: string
  // The label an offering's own objects carry, e.g. "cnpg.io/cluster". Network
  // coverage is only meaningful relative to one offering.
  offeringLabelKey: string | null
  // The target resource, for the permission hint.
  target: { group: string; plural: string } | null
  caller: { sub: string; groups: string[]; usernamePrefixes: string[] } | null
}

export type NamespaceFactsResult = { fact: NamespaceFact; degraded: DegradedRead[] }

export async function getNamespaceFacts(input: NamespaceFactsInput): Promise<NamespaceFactsResult> {
  const { namespace } = input
  const degraded: DegradedRead[] = []

  const record = <T>(source: string, result: Awaited<ReturnType<typeof optional<T>>>, fallback: T): T => {
    if (result.known) return result.value
    // "absent" is not a misconfiguration — a cluster without Cilium simply has
    // no such CRD — so only an RBAC refusal is worth surfacing as degraded.
    if (result.reason === "rbac") {
      degraded.push({ source, status: 403, message: result.detail })
    }
    return fallback
  }

  const [quotas, limits, native, cilium, bindings, namespaceMeta] = await Promise.all([
    optional("resourcequotas", () =>
      kubeApiGet<{ items?: RawResourceQuota[] }>(`/api/v1/namespaces/${ns(namespace)}/resourcequotas`),
    ),
    optional("limitranges", () =>
      kubeApiGet<{ items?: RawLimitRange[] }>(`/api/v1/namespaces/${ns(namespace)}/limitranges`),
    ),
    optional("networkpolicies", () =>
      kubeApiGet<{ items?: RawNetworkPolicy[] }>(
        `/apis/networking.k8s.io/v1/namespaces/${ns(namespace)}/networkpolicies`,
      ),
    ),
    optional("ciliumnetworkpolicies", () =>
      kubeApiGet<{ items?: RawCiliumPolicy[] }>(
        `/apis/cilium.io/v2/namespaces/${ns(namespace)}/ciliumnetworkpolicies`,
      ),
    ),
    optional("rolebindings", () =>
      kubeApiGet<{ items?: RawRoleBinding[] }>(
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns(namespace)}/rolebindings`,
      ),
    ),
    optional("namespaces", () => kubeApiGet<RawNamespace>(`/api/v1/namespaces/${ns(namespace)}`)),
  ])

  const quotaItems = record("resourcequotas", quotas, { items: [] }).items ?? []
  const limitItems = record("limitranges", limits, { items: [] }).items ?? []
  const nativePolicies = record("networkpolicies", native, { items: [] }).items ?? []
  const ciliumPolicies = record("ciliumnetworkpolicies", cilium, { items: [] }).items ?? []
  const bindingItems = record("rolebindings", bindings, { items: [] }).items ?? []
  const meta = record("namespaces", namespaceMeta, {} as RawNamespace)

  // Several quotas can apply at once; the first is enough for headroom prose,
  // and the planner reports the dimension that binds.
  const quota = quotaItems[0] ?? null

  const selectors: PolicySelector[] = input.offeringLabelKey
    ? extractSelectors(input.offeringLabelKey, nativePolicies, ciliumPolicies)
    : []

  const permission =
    input.target && input.caller
      ? mayCreate(bindingItems, await resolveRoles(bindingItems, degraded), input.caller, input.target)
      : {
          mayCreate: "unknown" as const,
          reason: "No offering selected yet, so nothing has been checked.",
        }

  return {
    fact: {
      namespace,
      tenant: meta.metadata?.labels?.["codemowers.io/sandbox"] ?? null,
      quota: quota
        ? {
            name: quota.metadata?.name ?? "(unnamed)",
            used: quota.status?.used ?? {},
            hard: quota.status?.hard ?? quota.spec?.hard ?? {},
          }
        : null,
      headroom: computeHeadroom(quota),
      limitRange: containerDefaults(limitItems),
      network: {
        ingress: native.known ? detectPosture(nativePolicies, "Ingress") : "unknown",
        egress: native.known ? detectPosture(nativePolicies, "Egress") : "unknown",
        selectors,
        ciliumAvailable: cilium.known,
      },
      mayCreate: permission.mayCreate,
      mayCreateReason: permission.reason,
    },
    degraded,
  }
}

// Only the roles the bindings actually reference, and only the three built-ins
// our RBAC allows by name. Anything else resolves to "unknown", which the
// heuristic reports honestly rather than guessing at.
async function resolveRoles(bindings: RawRoleBinding[], degraded: DegradedRead[]): Promise<ResolvedRole[]> {
  const wanted = new Set(
    bindings
      .filter(b => b.roleRef?.kind === "ClusterRole")
      .map(b => b.roleRef?.name)
      .filter((name): name is string => name === "admin" || name === "edit" || name === "view"),
  )

  const resolved = await Promise.all(
    [...wanted].map(async name => {
      const role = await optional("clusterroles", () =>
        kubeApiGet<{ rules?: ResolvedRole["rules"] }>(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`),
      )
      if (!role.known) {
        if (role.reason === "rbac") degraded.push({ source: "clusterroles", status: 403, message: role.detail })
        return null
      }
      // The aggregation controller flattens aggregated rules into `.rules`, so
      // this single read is enough — no need for the labelled member roles.
      return { name, rules: role.value.rules ?? [] }
    }),
  )

  return resolved.filter((r): r is ResolvedRole => r !== null)
}
