import type { AggRow, Aggregated, PeerKind } from "./aggregate"

export type GraphNodeKind = "pod" | "namespace" | PeerKind
type Direction = "inbound" | "outbound"

export type GraphNode = {
  id: string
  kind: GraphNodeKind
  name: string
  typeTag: string
  subtitle: string
  inCount: number
  outCount: number
  lastSeen: number
  ports: string[]
  groupId: string | null
  peerCount: number
}

export type PodGraph = {
  nodes: GraphNode[]
}

export const POD_NODE_ID = "__pod__"

type PeerAccum = {
  id: string
  kind: PeerKind
  name: string
  typeTag: string
  groupId: string
  namespace: string
  primaryPort: number | string
  inCount: number
  outCount: number
  lastSeen: number
  ports: string[]
}

type GroupAccum = {
  id: string
  name: string
  typeTag: string
  inCount: number
  outCount: number
  lastSeen: number
  peers: Set<string>
}

export function buildPodGraph(aggregated: Aggregated, podName: string, podNamespace: string): PodGraph {
  const peers = new Map<string, PeerAccum>()
  const groups = new Map<string, GroupAccum>()

  const ingest = (row: AggRow, direction: Direction) => {
    if (row.protocol !== "TCP") return

    const id = row.label
    let peer = peers.get(id)
    if (!peer) {
      peer = newPeer(id, row)
      peers.set(id, peer)
    }
    if (direction === "inbound") peer.inCount += row.count
    else peer.outCount += row.count
    peer.lastSeen = Math.max(peer.lastSeen, row.lastSeen)
    peer.ports.push(`${row.port}/${row.protocol} ×${row.count}`)

    const group = upsertGroup(groups, peer)
    group.peers.add(id)
    if (direction === "inbound") group.inCount += row.count
    else group.outCount += row.count
    group.lastSeen = Math.max(group.lastSeen, row.lastSeen)
  }

  for (const row of aggregated.inbound) ingest(row, "inbound")
  for (const row of aggregated.inClusterOut) ingest(row, "outbound")
  for (const row of aggregated.unknownOut) ingest(row, "outbound")
  for (const row of aggregated.external) ingest(row, "outbound")

  const nodes: GraphNode[] = [
    {
      id: POD_NODE_ID,
      kind: "pod",
      name: podName,
      typeTag: "POD",
      subtitle: podNamespace,
      inCount: 0,
      outCount: 0,
      lastSeen: 0,
      ports: [],
      groupId: null,
      peerCount: 0,
    },
  ]

  for (const group of groups.values()) {
    nodes.push({
      id: group.id,
      kind: "namespace",
      name: group.name,
      typeTag: group.typeTag,
      subtitle: `${group.peers.size}`,
      inCount: group.inCount,
      outCount: group.outCount,
      lastSeen: group.lastSeen,
      ports: [],
      groupId: null,
      peerCount: group.peers.size,
    })
  }

  for (const peer of peers.values()) {
    nodes.push({
      id: peer.id,
      kind: peer.kind,
      name: peer.name,
      typeTag: peer.typeTag,
      subtitle: peer.kind === "workload" ? peer.namespace : `:${peer.primaryPort}`,
      inCount: peer.inCount,
      outCount: peer.outCount,
      lastSeen: peer.lastSeen,
      ports: peer.ports,
      groupId: peer.groupId,
      peerCount: 0,
    })
  }

  return { nodes }
}

function newPeer(id: string, row: AggRow): PeerAccum {
  if (row.kind === "workload") {
    const [kind, namespace, name] = row.label.split("/")
    return {
      id,
      kind: "workload",
      name: name ?? row.label,
      typeTag: (kind ?? "WORKLOAD").toUpperCase(),
      groupId: `ns:${namespace ?? "—"}`,
      namespace: namespace ?? "—",
      primaryPort: row.port,
      inCount: 0,
      outCount: 0,
      lastSeen: 0,
      ports: [],
    }
  }
  const external = row.kind === "external"
  return {
    id,
    kind: row.kind,
    name: row.label,
    typeTag: external ? "EXTERNAL" : "NODE",
    groupId: external ? "grp:external" : "grp:cluster-nodes",
    namespace: "",
    primaryPort: row.port,
    inCount: 0,
    outCount: 0,
    lastSeen: 0,
    ports: [],
  }
}

function upsertGroup(groups: Map<string, GroupAccum>, peer: PeerAccum): GroupAccum {
  let group = groups.get(peer.groupId)
  if (group) return group
  group = {
    id: peer.groupId,
    name: groupName(peer),
    typeTag: groupTypeTag(peer),
    inCount: 0,
    outCount: 0,
    lastSeen: 0,
    peers: new Set(),
  }
  groups.set(peer.groupId, group)
  return group
}

function groupName(peer: PeerAccum): string {
  if (peer.kind === "workload") return peer.namespace
  return peer.kind === "external" ? "External" : "Cluster nodes"
}

function groupTypeTag(peer: PeerAccum): string {
  if (peer.kind === "workload") return "NAMESPACE"
  return peer.kind === "external" ? "EXTERNAL" : "CLUSTER"
}
