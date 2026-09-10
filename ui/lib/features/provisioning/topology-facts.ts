// PURE. Zones and capacity, plus the control-plane label — which differs per
// cluster (k3s uses node-role.kubernetes.io/control-plane=true, the AWS
// clusters codemowers.cloud/node-role=control-plane), so it is derived from the
// nodes rather than configured.

import { parseCpuMillis, parseQuantity } from "./quantity.ts"
import type { TopologyFact, ZoneFact } from "./types"

export type RawNode = {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: { unschedulable?: boolean; taints?: { key?: string; effect?: string }[] }
  status?: {
    allocatable?: Record<string, string>
    conditions?: { type?: string; status?: string }[]
  }
}

const ZONE_LABEL = "topology.kubernetes.io/zone"
const UNZONED = "(no zone label)"

// Ordered by specificity: a node carrying both should report the explicit one.
const CONTROL_PLANE_LABELS: { key: string; value: string | null }[] = [
  { key: "codemowers.cloud/node-role", value: "control-plane" },
  { key: "node-role.kubernetes.io/control-plane", value: null },
  { key: "node-role.kubernetes.io/master", value: null },
]

function isReady(node: RawNode): boolean {
  return node.status?.conditions?.some(c => c.type === "Ready" && c.status === "True") === true
}

// A node that cannot take a new pod should not count towards "can 3 instances
// fit": cordoned nodes and NoSchedule taints both take it out of the running.
export function isSchedulable(node: RawNode): boolean {
  if (node.spec?.unschedulable === true) return false
  if (!isReady(node)) return false
  const taints = node.spec?.taints ?? []
  return !taints.some(t => t.effect === "NoSchedule" || t.effect === "NoExecute")
}

export function detectControlPlaneLabel(nodes: RawNode[]): TopologyFact["controlPlaneLabel"] {
  for (const candidate of CONTROL_PLANE_LABELS) {
    for (const node of nodes) {
      const actual = node.metadata?.labels?.[candidate.key]
      if (actual === undefined) continue
      if (candidate.value !== null && actual !== candidate.value) continue
      return { key: candidate.key, value: candidate.value ?? actual }
    }
  }
  return null
}

export function toTopologyFact(nodes: RawNode[]): TopologyFact {
  const byZone = new Map<string, ZoneFact>()
  let schedulableNodes = 0

  for (const node of nodes) {
    if (!isSchedulable(node)) continue
    schedulableNodes += 1

    const zone = node.metadata?.labels?.[ZONE_LABEL] ?? UNZONED
    const cpuMillis = parseCpuMillis(node.status?.allocatable?.cpu) ?? 0
    const memoryBytes = parseQuantity(node.status?.allocatable?.memory) ?? 0

    const existing = byZone.get(zone)
    if (existing) {
      existing.nodes += 1
      existing.allocatable.cpuMillis += cpuMillis
      existing.allocatable.memoryBytes += memoryBytes
    } else {
      byZone.set(zone, { zone, nodes: 1, allocatable: { cpuMillis, memoryBytes } })
    }
  }

  return {
    zones: [...byZone.values()].sort((a, b) => a.zone.localeCompare(b.zone)),
    schedulableNodes,
    controlPlaneLabel: detectControlPlaneLabel(nodes),
  }
}

// How many distinct zones a spread constraint could actually use. An unzoned
// cluster reports 0, so "spread across zones" is honestly reported as decoration.
export function distinctZones(topology: TopologyFact): number {
  return topology.zones.filter(z => z.zone !== UNZONED).length
}
