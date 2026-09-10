import type { AggregateBucket, ListeningPort, PeerRef } from "./types"

export type PeerKind = "workload" | "unknown" | "external"

export type AggRow = {
  key: string
  label: string
  peer: PeerRef
  port: number | string
  protocol: string
  count: number
  lastSeen: number
  kind: PeerKind
}

export type Aggregated = {
  inClusterOut: AggRow[]
  unknownOut: AggRow[]
  external: AggRow[]
  inbound: AggRow[]
}

export function peerLabel(peer: PeerRef, peerIP: string): string {
  if (peer.class === "workload") {
    if (peer.restricted) return `pod in ${peer.namespace ?? "?"}`
    return `${peer.ownerKind}/${peer.namespace}/${peer.name}`
  }
  if (peer.class === "service") return `Service/${peer.namespace}/${peer.name}`
  if (peer.class === "node") return peer.nodeName ?? peerIP
  return peerIP || "?"
}

export function peerKind(peer: PeerRef): PeerKind {
  if (peer.class === "workload" || peer.class === "service") return "workload"
  if (peer.class === "external") return "external"
  return "unknown"
}

export function aggregate(
  aggregates: Map<string, AggregateBucket>,
  localIPFilter?: Set<string>,
): Aggregated {
  const inClusterOut: AggRow[] = []
  const unknownOut: AggRow[] = []
  const external: AggRow[] = []
  const inbound: AggRow[] = []

  for (const bucket of aggregates.values()) {
    if (localIPFilter && !intersects(bucket.localIPs, localIPFilter)) continue

    const kind = peerKind(bucket.peer)
    const row: AggRow = {
      key: bucket.key,
      label: peerLabel(bucket.peer, bucket.peerIP),
      peer: bucket.peer,
      port: bucket.port,
      protocol: bucket.protocol,
      count: bucket.count,
      lastSeen: bucket.lastSeen,
      kind,
    }

    if (bucket.direction === "inbound") inbound.push(row)
    else if (kind === "workload") inClusterOut.push(row)
    else if (kind === "unknown") unknownOut.push(row)
    else external.push(row)
  }

  return {
    inClusterOut: stableSort(mergeByLabel(inClusterOut)),
    unknownOut: stableSort(unknownOut),
    external: stableSort(external),
    inbound: stableSort(mergeByLabel(inbound)),
  }
}

export function recentCounts(
  aggregates: Map<string, AggregateBucket>,
  now: number,
  windowMs: number,
  podIPs?: Set<string>,
): { inbound: number; outbound: number } {
  let inbound = 0
  let outbound = 0
  for (const bucket of aggregates.values()) {
    if (now - bucket.lastSeen > windowMs) continue
    if (podIPs && !intersects(bucket.localIPs, podIPs)) continue
    if (bucket.direction === "inbound") inbound++
    else outbound++
  }
  return { inbound, outbound }
}

export function filterListening(
  listening: Map<string, ListeningPort>,
  ourPodUids: Set<string>,
): ListeningPort[] {
  const out: ListeningPort[] = []
  for (const port of listening.values()) {
    if (port.ownerPodUid && ourPodUids.has(port.ownerPodUid)) out.push(port)
  }
  out.sort((a, b) => {
    if (a.port !== b.port) return a.port - b.port
    return a.ip.localeCompare(b.ip)
  })
  return out
}

export type ListeningGroup = {
  key: string
  port: number
  protocol: string
  addresses: ListeningPort[]
}

export function groupListening(ports: ListeningPort[]): ListeningGroup[] {
  const byKey = new Map<string, ListeningGroup>()
  for (const p of ports) {
    const key = `${p.port}::${p.protocol}`
    const group = byKey.get(key)
    if (group) group.addresses.push(p)
    else byKey.set(key, { key, port: p.port, protocol: p.protocol, addresses: [p] })
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port)
}

function mergeByLabel(rows: AggRow[]): AggRow[] {
  const merged = new Map<string, AggRow>()
  for (const row of rows) {
    const key = `${row.label}::${row.port}::${row.protocol}`
    const prev = merged.get(key)
    if (prev)
      merged.set(key, {
        ...prev,
        count: prev.count + row.count,
        lastSeen: Math.max(prev.lastSeen, row.lastSeen),
      })
    else merged.set(key, { ...row, key })
  }
  return [...merged.values()]
}

function stableSort(rows: AggRow[]): AggRow[] {
  return rows.sort((a, b) => {
    if (a.label !== b.label) return a.label.localeCompare(b.label)
    if (a.port !== b.port) return String(a.port).localeCompare(String(b.port))
    return b.count - a.count
  })
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const v of small) if (large.has(v)) return true
  return false
}
