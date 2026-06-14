import { create } from "zustand"
import { NETSTATD_ENDPOINT_URL } from "../constants"
import { useClusterState } from "../cluster-state"
import { findDescendantPodUids, type WorkloadScope } from "./selectors"
import type {
  AggregateDirection,
  ConnectionEvent,
  HostInfoEvent,
  ListeningPort,
  NetstatdEvent,
  NetstatdState,
  PortListeningEvent,
  Protocol,
} from "./types"

const initial = (): NetstatdState => ({
  status: "idle",
  error: null,
  lastFlushedAt: null,
  aggregates: new Map(),
  listening: new Map(),
  hosts: new Map(),
  hiddenCount: 0,
})

export const useNetstatd = create<NetstatdState>(initial)

let cachedNetstatdUrl: string | null = null
async function fetchNetstatdUrl(): Promise<string> {
  if (cachedNetstatdUrl !== null) return cachedNetstatdUrl
  const res = await fetch(NETSTATD_ENDPOINT_URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`Failed to discover netstatd endpoint: ${res.status}`)
  const json = (await res.json()) as { url?: string }
  cachedNetstatdUrl = json.url ?? ""
  return cachedNetstatdUrl
}

const HOLDING_BUFFER_MS = 10_000
const PRUNE_INTERVAL_MS = 10_000
const AGG_CAP = 2_000
const LISTENING_CAP = 2_000
const FLUSH_DEBOUNCE_MS = 50
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000]
const COLD_START_CONNECT_FALLBACK_MS = 1_500

let socket: WebSocket | null = null
let refCount = 0
let currentWorkloadUid: string | null = null
let scope: WorkloadScope = { podUids: new Set(), podIPs: new Set(), nodes: new Set() }
let scopeUnsub: (() => void) | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let pruneTimer: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let coldStartTimer: ReturnType<typeof setTimeout> | null = null
let pendingEvents: NetstatdEvent[] = []
let holdingBuffer: { event: ConnectionEvent | PortListeningEvent; receivedAt: number }[] = []
let connectedNodes: Set<string> = new Set()
let connectGeneration = 0

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    drainPending()
  }, FLUSH_DEBOUNCE_MS)
}

type AggParts = {
  key: string
  direction: AggregateDirection
  peerIP: string
  port: number
  protocol: Protocol
  localIP: string
}

function isLocalPortListening(
  listening: Map<string, ListeningPort>,
  localIP: string,
  localPort: number | undefined,
  protocol: Protocol,
): boolean {
  if (localPort === undefined) return false
  for (const port of listening.values()) {
    if (port.protocol !== protocol) continue
    if (port.port !== localPort) continue
    if (port.ip === localIP) return true
    if (port.ip === "0.0.0.0" || port.ip === "::") return true
  }
  return false
}

function classifyEvent(event: ConnectionEvent, listening: Map<string, ListeningPort>): AggParts | null {
  const localIP = event.localIP
  if (!localIP) return null

  let direction: AggregateDirection
  let port: number | undefined
  if (event.type === "connection.accepted") {
    direction = "inbound"
    port = event.localPort
  } else if (isLocalPortListening(listening, localIP, event.localPort, event.protocol)) {
    direction = "inbound"
    port = event.localPort
  } else {
    direction = "outbound"
    port = event.remotePort
  }

  const peerIP = event.remoteIP
  if (!peerIP || port === undefined) return null

  const dir = direction === "inbound" ? "in" : "out"
  return {
    key: `${dir}:${peerIP}:${port}:${event.protocol}`,
    direction,
    peerIP,
    port,
    protocol: event.protocol,
    localIP,
  }
}

function bumpAggregate(state: NetstatdState, parts: AggParts, now: number): void {
  const existing = state.aggregates.get(parts.key)
  if (existing) {
    const localIPs = existing.localIPs.has(parts.localIP)
      ? existing.localIPs
      : new Set(existing.localIPs).add(parts.localIP)
    state.aggregates.set(parts.key, {
      ...existing,
      count: existing.count + 1,
      lastSeen: now,
      localIPs,
    })
    return
  }
  state.aggregates.set(parts.key, {
    key: parts.key,
    direction: parts.direction,
    peerIP: parts.peerIP,
    port: parts.port,
    protocol: parts.protocol,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    localIPs: new Set([parts.localIP]),
  })
}

function applyHostInfo(state: NetstatdState, event: HostInfoEvent): void {
  if (!event.nodeName) return
  state.hosts.set(event.nodeName, {
    nodeName: event.nodeName,
    hostIPs: new Set(event.hostIPs),
    hostNetNS: event.hostNetNS,
  })
}

function applyPortListening(state: NetstatdState, event: PortListeningEvent): void {
  const key = `${event.nodeName ?? ""}:${event.netns}:${event.protocol}:${event.ip}:${event.port}`
  state.listening.set(key, {
    key,
    protocol: event.protocol,
    ip: event.ip,
    port: event.port,
    nodeName: event.nodeName,
    netns: event.netns,
    isHostNetNS: event.isHostNetNS,
  })
}

function drainPending() {
  if (pendingEvents.length === 0) return
  const events = pendingEvents
  pendingEvents = []

  useNetstatd.setState(prev => {
    const state: NetstatdState = {
      ...prev,
      aggregates: new Map(prev.aggregates),
      listening: new Map(prev.listening),
      hosts: new Map(prev.hosts),
    }
    const now = Date.now()
    const scopeReady = scope.podUids.size > 0

    for (const event of events) {
      switch (event.type) {
        case "host.info":
          applyHostInfo(state, event)
          break
        case "port.listening":
          if (!scopeReady) holdingBuffer.push({ event, receivedAt: now })
          else if (scope.podIPs.has(event.ip)) applyPortListening(state, event)
          break
        case "connection.event":
        case "connection.accepted":
          if (!scopeReady) {
            holdingBuffer.push({ event, receivedAt: now })
          } else if (scope.podIPs.has(event.localIP)) {
            const parts = classifyEvent(event, state.listening)
            if (parts) bumpAggregate(state, parts, now)
          }
          break
      }
    }

    if (scopeReady && holdingBuffer.length > 0) replayHoldingBuffer(state, now)

    state.lastFlushedAt = now
    return state
  })
}

function replayHoldingBuffer(state: NetstatdState, now: number) {
  for (const item of holdingBuffer) {
    if (now - item.receivedAt > HOLDING_BUFFER_MS) continue
    const event = item.event
    if (event.type === "port.listening") {
      if (scope.podIPs.has(event.ip)) applyPortListening(state, event)
    } else if (scope.podIPs.has(event.localIP)) {
      const parts = classifyEvent(event, state.listening)
      if (parts) bumpAggregate(state, parts, now)
    }
  }
  holdingBuffer = []
}

function flushHoldingBuffer() {
  if (holdingBuffer.length === 0) return
  useNetstatd.setState(prev => {
    const state: NetstatdState = {
      ...prev,
      aggregates: new Map(prev.aggregates),
      listening: new Map(prev.listening),
      hosts: new Map(prev.hosts),
    }
    const now = Date.now()
    replayHoldingBuffer(state, now)
    state.lastFlushedAt = now
    return state
  })
}

function prune() {
  useNetstatd.setState(prev => {
    const now = Date.now()
    holdingBuffer = holdingBuffer.filter(item => now - item.receivedAt <= HOLDING_BUFFER_MS)

    let mutated = false
    let aggregates = prev.aggregates
    let listening = prev.listening
    let hiddenCount = prev.hiddenCount

    if (aggregates.size > AGG_CAP) {
      const sorted = [...aggregates.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      const toDrop = sorted.length - AGG_CAP
      aggregates = new Map(aggregates)
      for (let i = 0; i < toDrop; i++) aggregates.delete(sorted[i][0])
      hiddenCount += toDrop
      mutated = true
    }

    if (listening.size > LISTENING_CAP) {
      const keys = [...listening.keys()]
      const toDrop = listening.size - LISTENING_CAP
      listening = new Map(listening)
      for (let i = 0; i < toDrop; i++) listening.delete(keys[i])
      mutated = true
    }

    if (!mutated) return prev
    return { ...prev, aggregates, listening, hiddenCount }
  })
}

function mergeScope(): boolean {
  if (currentWorkloadUid === null) return false
  const candidate = findDescendantPodUids(useClusterState.getState().clusterResources, currentWorkloadUid)
  if (candidate.podUids.size === 0) return false

  const prevNodeCount = scope.nodes.size
  const podUids = new Set(scope.podUids)
  const podIPs = new Set(scope.podIPs)
  const nodes = new Set(scope.nodes)
  for (const u of candidate.podUids) podUids.add(u)
  for (const ip of candidate.podIPs) podIPs.add(ip)
  for (const n of candidate.nodes) nodes.add(n)
  scope = { podUids, podIPs, nodes }

  return nodes.size > prevNodeCount
}

function deriveNodeQuery(nodeSet: Set<string>): string {
  if (nodeSet.size === 0) return ""
  const list = [...nodeSet].sort().join(",")
  return `?match=any&nodes=${encodeURIComponent(list)}`
}

function openSocket() {
  if (coldStartTimer !== null) {
    clearTimeout(coldStartTimer)
    coldStartTimer = null
  }
  useNetstatd.setState({ status: "connecting", error: null })
  const gen = ++connectGeneration
  const nodesForThisConnect = new Set(scope.nodes)

  fetchNetstatdUrl()
    .then(url => {
      if (gen !== connectGeneration) return
      if (!url) {
        useNetstatd.setState({ status: "error", error: "Netstatd not configured" })
        return
      }
      const wsUrl = url
        .replace(/\/$/, "")
        .replace(/^http:\/\//, "ws://")
        .replace(/^https:\/\//, "wss://")
      try {
        socket = new WebSocket(`${wsUrl}/conntrack${deriveNodeQuery(nodesForThisConnect)}`)
      } catch (e) {
        useNetstatd.setState({ status: "error", error: String(e) })
        return
      }
      connectedNodes = nodesForThisConnect

      socket.onopen = () => {
        reconnectAttempt = 0
        useNetstatd.setState({ status: "open", error: null })
      }

      socket.onmessage = ev => {
        try {
          const parsed = JSON.parse(ev.data) as NetstatdEvent
          pendingEvents.push(parsed)
          scheduleFlush()
        } catch {
          // ignore malformed frames
        }
      }

      socket.onerror = () => {
        useNetstatd.setState({ status: "error", error: "WebSocket error" })
      }

      socket.onclose = () => {
        socket = null
        if (refCount > 0) {
          const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]
          reconnectAttempt++
          useNetstatd.setState({ status: "closed" })
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            if (refCount > 0) connect()
          }, delay)
        } else {
          useNetstatd.setState({ status: "closed" })
        }
      }
    })
    .catch(e => {
      if (gen !== connectGeneration) return
      useNetstatd.setState({ status: "error", error: String(e) })
    })
}

function connect() {
  const status = useNetstatd.getState().status
  if (status === "connecting" || status === "open") return
  openSocket()
}

function reconnectWithCurrentScope() {
  if (socket !== null) {
    socket.onclose = null
    socket.onmessage = null
    socket.onerror = null
    socket.onopen = null
    try {
      socket.close()
    } catch {
      // ignore
    }
    socket = null
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
  openSocket()
}

function maybeReconnectForNodes() {
  if (socket === null) return
  for (const n of scope.nodes) {
    if (!connectedNodes.has(n)) {
      reconnectWithCurrentScope()
      return
    }
  }
}

function onClusterStateChange() {
  const grew = mergeScope()
  if (scope.podUids.size > 0 && holdingBuffer.length > 0) flushHoldingBuffer()
  const status = useNetstatd.getState().status
  if ((status === "idle" || status === "closed") && socket === null && scope.nodes.size > 0) {
    connect()
  }
  if (grew) maybeReconnectForNodes()
}

function teardown() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (pruneTimer !== null) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (coldStartTimer !== null) {
    clearTimeout(coldStartTimer)
    coldStartTimer = null
  }
  if (socket !== null) {
    socket.onclose = null
    socket.onmessage = null
    socket.onerror = null
    socket.onopen = null
    try {
      socket.close()
    } catch {
      // ignore
    }
    socket = null
  }
  if (scopeUnsub !== null) {
    scopeUnsub()
    scopeUnsub = null
  }
  pendingEvents = []
  holdingBuffer = []
  reconnectAttempt = 0
  connectedNodes = new Set()
  currentWorkloadUid = null
  scope = { podUids: new Set(), podIPs: new Set(), nodes: new Set() }
  useNetstatd.setState(initial())
}

export function openNetstatdSession(workloadUid: string): () => void {
  refCount++
  if (refCount === 1) {
    currentWorkloadUid = workloadUid
    scope = { podUids: new Set(), podIPs: new Set(), nodes: new Set() }
    mergeScope()
    scopeUnsub = useClusterState.subscribe(onClusterStateChange)
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS)
    if (scope.nodes.size > 0) {
      connect()
    } else {
      coldStartTimer = setTimeout(() => {
        coldStartTimer = null
        connect()
      }, COLD_START_CONNECT_FALLBACK_MS)
    }
  } else if (currentWorkloadUid !== workloadUid) {
    currentWorkloadUid = workloadUid
    scope = { podUids: new Set(), podIPs: new Set(), nodes: new Set() }
    pendingEvents = []
    holdingBuffer = []
    mergeScope()
    useNetstatd.setState(initial())
    reconnectWithCurrentScope()
  }

  return () => {
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0) teardown()
  }
}
