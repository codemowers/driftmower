import { POD_NODE_ID, type GraphNode, type PodGraph } from "@/lib/features/netstatd"

export type Side = "in" | "out"
export type Point = { x: number; y: number }
export type Size = { w: number; h: number }
export type Rect = { minX: number; minY: number; maxX: number; maxY: number }

export type LayoutItem = {
  key: string
  node: GraphNode
  side: Side | null
  collapsed: boolean
}

export type LayoutEdge = {
  key: string
  fromKey: string
  toKey: string
  lastSeen: number
  count: number
}

export type Layout = {
  items: LayoutItem[]
  positions: Map<string, Point>
  sizes: Map<string, Size>
  edges: LayoutEdge[]
  bbox: Rect
}


const POD_W = 230
const CARD_W = 210
const PAD_Y = 9
const PAD_X = 12
const NAME_CHAR_W = 8.3
const SUB_CHAR_W = 6.4
const ICON_W = 20
const NAME_LH = 18
const SUB_LH = 14
const COUNT_LH = 16
const PORT_LH = 14

const COL_GAP = 130
const PEER_GAP = 70
const PEER_VGAP = 12
const NS_VGAP = 26
const ELBOW_RADIUS = 14

const COLLAPSE_THRESHOLD = 3
const RANK: Record<string, number> = { NAMESPACE: 0, CLUSTER: 1, EXTERNAL: 2 }

function isPeer(node: GraphNode): boolean {
  return node.kind !== "pod" && node.kind !== "namespace"
}

function maxLastSeen(nodes: GraphNode[]): number {
  return nodes.reduce((m, n) => Math.max(m, n.lastSeen), 0)
}

function hasDisclosure(node: GraphNode): boolean {
  if (node.kind === "namespace") return true
  if (isPeer(node)) return node.ports.length > 0
  return false
}

export function subtitleText(node: GraphNode): string {
  if (node.kind === "namespace") {
    return `${node.typeTag} · ${node.peerCount} ${node.peerCount === 1 ? "peer" : "peers"}`
  }
  if (node.kind === "pod") return `${node.typeTag} · ${node.subtitle}`
  return `${node.typeTag}${node.subtitle ? ` · ${node.subtitle}` : ""}`
}

function charsPerLine(width: number, charWidth: number): number {
  return Math.max(6, Math.floor(width / charWidth))
}

function wrappedLines(text: string, perLine: number): number {
  let lines = 1
  let col = 0
  for (const chunk of text.split(/(?<=[-\s])/)) {
    const len = chunk.length
    if (len === 0) continue
    if (col > 0 && col + len > perLine) {
      lines++
      col = 0
    }
    if (len > perLine) {
      const extra = Math.ceil(len / perLine) - 1
      lines += extra
      col = len - extra * perLine
    } else {
      col += len
    }
  }
  return lines
}

export function cardSize(node: GraphNode, expanded = false): Size {
  const w = node.kind === "pod" ? POD_W : CARD_W
  const inner = w - PAD_X * 2
  const nameWidth = inner - (hasDisclosure(node) ? ICON_W : 0)
  const nameLines = wrappedLines(node.name, charsPerLine(nameWidth, NAME_CHAR_W))
  const subLines = wrappedLines(subtitleText(node), charsPerLine(inner, SUB_CHAR_W))

  let h = PAD_Y * 2 + nameLines * NAME_LH + subLines * SUB_LH
  if (node.kind !== "pod") h += COUNT_LH
  if (expanded && isPeer(node) && node.ports.length > 0) h += node.ports.length * PORT_LH + 4
  return { w, h }
}

function laneSort(a: GraphNode, b: GraphNode): number {
  const ra = RANK[a.typeTag] ?? 0
  const rb = RANK[b.typeTag] ?? 0
  if (ra !== rb) return ra - rb
  return a.name.localeCompare(b.name)
}

function peerSort(a: GraphNode, b: GraphNode): number {
  if (a.typeTag !== b.typeTag) return a.typeTag.localeCompare(b.typeTag)
  return a.name.localeCompare(b.name)
}

export function buildLayout(
  graph: PodGraph,
  overrides: Map<string, boolean>,
  expandedPeers: Set<string>,
): Layout {
  const positions = new Map<string, Point>()
  const sizes = new Map<string, Size>()
  const items: LayoutItem[] = []
  const edges: LayoutEdge[] = []

  const pod = graph.nodes.find(n => n.id === POD_NODE_ID)
  if (!pod) return { items, positions, sizes, edges, bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }

  const podSize = cardSize(pod)
  positions.set(pod.id, { x: 0, y: 0 })
  sizes.set(pod.id, podSize)
  items.push({ key: pod.id, node: pod, side: null, collapsed: false })

  const nsById = new Map(graph.nodes.filter(n => n.kind === "namespace").map(n => [n.id, n]))
  const peers = graph.nodes.filter(isPeer)

  const nsX = podSize.w / 2 + COL_GAP + CARD_W / 2
  const peerX = nsX + CARD_W / 2 + PEER_GAP + CARD_W / 2

  const addEdge = (k1: string, k2: string, lastSeen: number, count: number) => {
    const x1 = positions.get(k1)?.x ?? 0
    const x2 = positions.get(k2)?.x ?? 0
    const [fromKey, toKey] = x1 <= x2 ? [k1, k2] : [k2, k1]
    edges.push({ key: `${fromKey}->${toKey}`, fromKey, toKey, lastSeen, count })
  }

  const placeSide = (side: Side, dir: -1 | 1) => {
    const sideCount = (n: GraphNode) => (side === "in" ? n.inCount : n.outCount)
    const sidePeers = peers.filter(p => (side === "in" ? p.inCount > 0 : p.outCount > 0))
    const byGroup = new Map<string, GraphNode[]>()
    for (const p of sidePeers) {
      if (!p.groupId) continue
      const arr = byGroup.get(p.groupId) ?? []
      arr.push(p)
      byGroup.set(p.groupId, arr)
    }

    const lanes = [...byGroup.entries()]
      .map(([id, lanePeers]) => ({ ns: nsById.get(id), peers: lanePeers.slice().sort(peerSort) }))
      .filter((l): l is { ns: GraphNode; peers: GraphNode[] } => Boolean(l.ns))
      .sort((a, b) => laneSort(a.ns, b.ns))

    const blocks = lanes.map(lane => {
      const laneKey = `${side}:${lane.ns.id}`
      const collapsed = overrides.get(laneKey) ?? lane.peers.length > COLLAPSE_THRESHOLD
      const visiblePeers = collapsed ? [] : lane.peers
      const peerSizes = visiblePeers.map(p => cardSize(p, expandedPeers.has(`${side}:${p.id}`)))
      const peersH = peerSizes.length
        ? peerSizes.reduce((s, ps) => s + ps.h, 0) + (peerSizes.length - 1) * PEER_VGAP
        : 0
      const nsSize = cardSize(lane.ns)
      return { lane, laneKey, collapsed, visiblePeers, peerSizes, nsSize, height: Math.max(nsSize.h, peersH), peersH }
    })

    const totalH = blocks.reduce((s, b) => s + b.height, 0) + Math.max(0, blocks.length - 1) * NS_VGAP
    let y = -totalH / 2

    for (const block of blocks) {
      const center = y + block.height / 2
      positions.set(block.laneKey, { x: dir * nsX, y: center })
      sizes.set(block.laneKey, block.nsSize)
      items.push({ key: block.laneKey, node: block.lane.ns, side, collapsed: block.collapsed })
      addEdge(pod.id, block.laneKey, maxLastSeen(block.lane.peers), sideCount(block.lane.ns))

      let py = center - block.peersH / 2
      block.visiblePeers.forEach((peer, i) => {
        const peerKey = `${side}:${peer.id}`
        const ps = block.peerSizes[i]
        positions.set(peerKey, { x: dir * peerX, y: py + ps.h / 2 })
        sizes.set(peerKey, ps)
        items.push({ key: peerKey, node: peer, side, collapsed: false })
        addEdge(block.laneKey, peerKey, peer.lastSeen, sideCount(peer))
        py += ps.h + PEER_VGAP
      })

      y += block.height + NS_VGAP
    }
  }

  placeSide("in", -1)
  placeSide("out", 1)

  return { items, positions, sizes, edges, bbox: boundingBox(positions, sizes) }
}

function boundingBox(positions: Map<string, Point>, sizes: Map<string, Size>): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [key, p] of positions) {
    const s = sizes.get(key) ?? { w: 0, h: 0 }
    minX = Math.min(minX, p.x - s.w / 2)
    minY = Math.min(minY, p.y - s.h / 2)
    maxX = Math.max(maxX, p.x + s.w / 2)
    maxY = Math.max(maxY, p.y + s.h / 2)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

export type Endpoints = { sx: number; sy: number; tx: number; ty: number }

export function edgeEndpoints(edge: LayoutEdge, layout: Layout): Endpoints | null {
  const fp = layout.positions.get(edge.fromKey)
  const tp = layout.positions.get(edge.toKey)
  const fs = layout.sizes.get(edge.fromKey)
  const ts = layout.sizes.get(edge.toKey)
  if (!fp || !tp || !fs || !ts) return null
  return { sx: fp.x + fs.w / 2, sy: fp.y, tx: tp.x - ts.w / 2, ty: tp.y }
}

export function elbowPath({ sx, sy, tx, ty }: Endpoints): string {
  if (Math.abs(sy - ty) < 1) return `M ${sx} ${sy} L ${tx} ${ty}`
  const midX = (sx + tx) / 2
  const dx = Math.sign(tx - sx) || 1
  const dy = Math.sign(ty - sy)
  const r = Math.min(ELBOW_RADIUS, Math.abs(tx - sx) / 2, Math.abs(ty - sy) / 2)
  return [
    `M ${sx} ${sy}`,
    `L ${midX - dx * r} ${sy}`,
    `Q ${midX} ${sy} ${midX} ${sy + dy * r}`,
    `L ${midX} ${ty - dy * r}`,
    `Q ${midX} ${ty} ${midX + dx * r} ${ty}`,
    `L ${tx} ${ty}`,
  ].join(" ")
}
