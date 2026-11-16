import type { ClusterResource } from "./cluster-state"
import type { Chip } from "./pod-security"

export type PodSpread = { kind: "topologySpreadConstraint" | "podAntiAffinity"; topologyKey: string; hard: boolean }

const OK = "bg-status-ok-bg text-status-ok-label"
const YELLOW = "bg-status-patch-bg text-status-patch-label"
const ORANGE = "bg-status-minor-bg text-status-minor-label"

const KEY_NAMES: Record<string, string> = {
  "kubernetes.io/hostname": "node",
  "topology.kubernetes.io/zone": "zone",
  "topology.kubernetes.io/region": "region",
}

// Whether a workload's live Pods survive losing one node or zone: two or
// more replicas, kept apart by topology spread constraints or pod
// anti-affinity. The tooltip names each rule's topology key.
export function availabilityChip(pods: ClusterResource[]): Chip | null {
  if (pods.length === 0) return null
  const nodes = new Set(pods.map(p => p.nodeName).filter(Boolean))
  const rules = new Map<string, PodSpread>()
  for (const p of pods) for (const r of p.spread ?? []) {
    const key = `${r.kind}/${r.topologyKey}`
    const seen = rules.get(key)
    if (!seen || (r.hard && !seen.hard)) rules.set(key, r)
  }
  const lines = [...rules.values()].map(r =>
    `${r.kind === "podAntiAffinity" ? "Pod anti-affinity" : "Topology spread"} by ${r.topologyKey} (${r.hard ? "required" : "preferred"})`)
  const placement = `${pods.length} Pod${pods.length === 1 ? "" : "s"} on ${nodes.size} node${nodes.size === 1 ? "" : "s"}`
  const title = [placement, ...lines].join("\n")
  if (pods.length < 2) return { label: "single replica", className: ORANGE, title }
  if (rules.size === 0) {
    return nodes.size < 2
      ? { label: "replicas on one node", className: ORANGE, title: `${title}\nNo topology spread or anti-affinity` }
      : { label: "replicas unspread", className: YELLOW, title: `${title}\nNo topology spread or anti-affinity; the scheduler happened to place them apart` }
  }
  const hard = [...rules.values()].some(r => r.hard)
  const keys = [...new Set([...rules.values()].map(r => KEY_NAMES[r.topologyKey] ?? r.topologyKey))]
  return { label: `HA by ${keys.join(", ")}`, className: hard && nodes.size > 1 ? OK : YELLOW, title }
}
