import { create } from "zustand"
import { CONFIG_URL } from "../constants"
import { useClusterState } from "../cluster-state"
import { findDescendantPodUids, type WorkloadScope } from "./selectors"

export type Protocol = "TCP" | "UDP"

export type ConnState =
  | "ESTABLISHED" | "SYN_SENT" | "SYN_RECV" | "FIN_WAIT1" | "FIN_WAIT2"
  | "TIME_WAIT" | "CLOSE" | "CLOSE_WAIT" | "LAST_ACK" | "LISTEN" | "CLOSING"

type ConnectionEvent = {
  type: "connection.event" | "connection.accepted"
  timestamp: string
  nodeName?: string
  protocol: Protocol
  state: ConnState
  sockCookie: string | number
  localIP: string
  remoteIP: string
  localPort?: number
  remotePort?: number
  pid?: number
}

type PortListeningEvent = {
  type: "port.listening"
  timestamp: string
  nodeName?: string
  protocol: Protocol
  ip: string
  port: number
  netns: number
  isHostNetNS: boolean
}

type ProcessMetainfoEvent = {
  type: "process.metainfo"
  timestamp: string
  nodeName: string
  pid: number
  exe?: string
  netns: number
  isHostNetNS: boolean
  cgroupSlice: string
  containerUid?: string
}

type ContainerEvent = {
  type: "container.added" | "container.metainfo"
  timestamp: string
  nodeName?: string
  containerUid: string
  name?: string
  podName?: string
  namespace?: string
  podUid?: string
  containerName?: string
  image?: string
  labels?: Record<string, string>
}

type HostInfoEvent = {
  type: "host.info"
  timestamp: string
  nodeName?: string
  hostIPs: string[]
  hostNetNS: number
  imageHash?: string
}

type NetstatdEvent =
  | ConnectionEvent
  | PortListeningEvent
  | ProcessMetainfoEvent
  | ContainerEvent
  | HostInfoEvent

export type Connection = {
  sockCookie: string
  protocol: Protocol
  state: ConnState
  nodeName?: string
  localIP: string
  remoteIP: string
  localPort?: number
  remotePort?: number
  pid?: number
  inbound: boolean
  firstSeen: number
  lastSeen: number
  aggKey?: string
}

export type ListeningPort = {
  key: string
  protocol: Protocol
  ip: string
  port: number
  nodeName?: string
  netns: number
  isHostNetNS: boolean
  containerUid?: string
}

export type ContainerInfo = {
  containerUid: string
  podUid?: string
  podName?: string
  namespace?: string
  containerName?: string
  image?: string
  nodeName?: string
}

export type ProcessInfo = {
  key: string
  pid: number
  nodeName: string
  netns: number
  isHostNetNS: boolean
  cgroupSlice: string
  containerUid?: string
  exe?: string
}

export type HostInfo = {
  nodeName: string
  hostIPs: Set<string>
  hostNetNS: number
}

export type AggregateDirection = "inbound" | "outbound"

export type AggregateBucket = {
  key: string
  direction: AggregateDirection
  peerIP: string
  port: number
  protocol: Protocol
  count: number
  firstSeen: number
  lastSeen: number
}

export type NetstatdStatus = "idle" | "connecting" | "open" | "closed" | "error"

export type NetstatdState = {
  status: NetstatdStatus
  error: string | null
  rawEventCount: number
  lastFlushedAt: number | null
  revision: number

  connections: Map<string, Connection>
  aggregates: Map<string, AggregateBucket>
  cookieToAgg: Map<string, string>
  listening: Map<string, ListeningPort>
  containersByUid: Map<string, ContainerInfo>
  containersByPodUid: Map<string, Set<string>>
  processes: Map<string, ProcessInfo>
  pidByContainerUid: Map<string, Set<string>>
  pidBySockCookie: Map<string, number>
  hosts: Map<string, HostInfo>
}

const initial = (): NetstatdState => ({
  status: "idle",
  error: null,
  rawEventCount: 0,
  lastFlushedAt: null,
  revision: 0,
  connections: new Map(),
  aggregates: new Map(),
  cookieToAgg: new Map(),
  listening: new Map(),
  containersByUid: new Map(),
  containersByPodUid: new Map(),
  processes: new Map(),
  pidByContainerUid: new Map(),
  pidBySockCookie: new Map(),
  hosts: new Map(),
})

export const useNetstatd = create<NetstatdState>(initial)

let cachedNetstatdUrl: string | null = null
async function fetchNetstatdUrl(): Promise<string> {
  if (cachedNetstatdUrl !== null) return cachedNetstatdUrl
  const res = await fetch(CONFIG_URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`Failed to fetch runtime config: ${res.status}`)
  const json = (await res.json()) as { netstatdPublicUrl?: string }
  cachedNetstatdUrl = json.netstatdPublicUrl ?? ""
  return cachedNetstatdUrl
}

const HOLDING_BUFFER_MS = 10_000
const PRUNE_INTERVAL_MS = 10_000
const CONN_CAP = 200
const AGG_CAP = 500
const COOKIE_AGG_CAP = 5_000
const FLUSH_DEBOUNCE_MS = 50
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000]

let socket: WebSocket | null = null
let refCount = 0
let currentWorkloadUid: string | null = null
let scope: WorkloadScope = { podUids: new Set(), podIPs: new Set(), containerUidByPodUid: new Map() }
let scopeUnsub: (() => void) | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let pruneTimer: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingEvents: NetstatdEvent[] = []
let holdingBuffer: { event: ConnectionEvent | PortListeningEvent; receivedAt: number }[] = []

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    drainPending()
  }, FLUSH_DEBOUNCE_MS)
}

function recomputeScope() {
  if (currentWorkloadUid === null) {
    scope = { podUids: new Set(), podIPs: new Set(), containerUidByPodUid: new Map() }
    return
  }
  scope = findDescendantPodUids(useClusterState.getState().explorerResources, currentWorkloadUid)
}

function isOursOrPending(
  event: ConnectionEvent | PortListeningEvent,
  state: NetstatdState,
): "ours" | "pending" | "drop" {
  if (event.type === "port.listening") {
    return classifyByPodIP(event.ip, undefined)
  }

  const sockCookieKey = String(event.sockCookie)
  const pid = event.pid ?? state.pidBySockCookie.get(sockCookieKey)

  if (pid !== undefined && event.nodeName) {
    const procKey = `${event.nodeName}:${pid}`
    const proc = state.processes.get(procKey)
    if (proc?.containerUid) {
      const ci = state.containersByUid.get(proc.containerUid)
      if (ci?.podUid && scope.podUids.has(ci.podUid)) return "ours"
      if (ci?.podUid) return "drop"
    }
  }

  return classifyByPodIP(event.localIP, event.remoteIP)
}

function classifyByPodIP(localIP: string, remoteIP: string | undefined): "ours" | "pending" | "drop" {
  if (scope.podIPs.has(localIP)) return "ours"
  if (remoteIP !== undefined && scope.podIPs.has(remoteIP)) return "ours"
  if (scope.podUids.size === 0) return "pending"
  return "drop"
}

function computeAggKey(conn: Connection): string | null {
  if (conn.inbound) {
    if (conn.localPort === undefined || !conn.remoteIP) return null
    return `in:${conn.remoteIP}:${conn.localPort}:${conn.protocol}`
  }
  if (conn.remotePort === undefined || !conn.remoteIP) return null
  return `out:${conn.remoteIP}:${conn.remotePort}:${conn.protocol}`
}

function parseAggKey(key: string): { direction: AggregateDirection; peerIP: string; port: number; protocol: Protocol } | null {
  const [dir, peerIP, portStr, protocol] = splitAggKey(key)
  if (!dir || !peerIP || !portStr || !protocol) return null
  const port = Number(portStr)
  if (!Number.isFinite(port)) return null
  return {
    direction: dir === "in" ? "inbound" : "outbound",
    peerIP,
    port,
    protocol: protocol as Protocol,
  }
}

function splitAggKey(key: string): [string, string, string, string] {
  const firstColon = key.indexOf(":")
  const lastColon = key.lastIndexOf(":")
  const middle = key.slice(firstColon + 1, lastColon)
  const lastPortBreak = middle.lastIndexOf(":")
  return [
    key.slice(0, firstColon),
    middle.slice(0, lastPortBreak),
    middle.slice(lastPortBreak + 1),
    key.slice(lastColon + 1),
  ]
}

function incrementAggregate(state: NetstatdState, key: string, now: number): void {
  const existing = state.aggregates.get(key)
  if (existing) {
    state.aggregates.set(key, { ...existing, count: existing.count + 1, lastSeen: now })
    return
  }
  const parsed = parseAggKey(key)
  if (!parsed) return
  state.aggregates.set(key, {
    key,
    direction: parsed.direction,
    peerIP: parsed.peerIP,
    port: parsed.port,
    protocol: parsed.protocol,
    count: 1,
    firstSeen: now,
    lastSeen: now,
  })
}

function decrementAggregate(state: NetstatdState, key: string): void {
  const existing = state.aggregates.get(key)
  if (!existing) return
  if (existing.count <= 1) {
    state.aggregates.delete(key)
    return
  }
  state.aggregates.set(key, { ...existing, count: existing.count - 1 })
}

function syncAggregateForConnection(
  state: NetstatdState,
  cookieKey: string,
  conn: Connection,
  now: number,
): Connection {
  const newKey = computeAggKey(conn)
  const prevKey = state.cookieToAgg.get(cookieKey)

  if (newKey === prevKey) {
    if (newKey) {
      const existing = state.aggregates.get(newKey)
      if (existing) state.aggregates.set(newKey, { ...existing, lastSeen: now })
    }
    return { ...conn, aggKey: newKey ?? undefined }
  }

  if (prevKey) decrementAggregate(state, prevKey)
  if (newKey) {
    incrementAggregate(state, newKey, now)
    state.cookieToAgg.set(cookieKey, newKey)
  } else if (prevKey) {
    state.cookieToAgg.delete(cookieKey)
  }

  return { ...conn, aggKey: newKey ?? undefined }
}

function applyConnectionEvent(state: NetstatdState, event: ConnectionEvent, now: number): NetstatdState {
  const sockCookieKey = String(event.sockCookie)
  const isAccepted = event.type === "connection.accepted"

  if (event.pid !== undefined && !state.pidBySockCookie.has(sockCookieKey)) {
    state.pidBySockCookie.set(sockCookieKey, event.pid)
  }

  const prev = state.connections.get(sockCookieKey)
  const localPort = event.localPort ?? prev?.localPort
  const localIP = event.localIP || prev?.localIP || ""
  const isLocalPortListening = matchesListeningPort(state, localIP, localPort, event.protocol)
  const merged: Connection = {
    sockCookie: sockCookieKey,
    protocol: event.protocol,
    state: event.state,
    nodeName: event.nodeName ?? prev?.nodeName,
    localIP,
    remoteIP: event.remoteIP || prev?.remoteIP || "",
    localPort,
    remotePort: event.remotePort ?? prev?.remotePort,
    pid: event.pid ?? prev?.pid,
    inbound: prev?.inbound || isAccepted || isLocalPortListening,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
    aggKey: prev?.aggKey,
  }

  const synced = syncAggregateForConnection(state, sockCookieKey, merged, now)
  state.connections.set(sockCookieKey, synced)

  return state
}

function matchesListeningPort(
  state: NetstatdState,
  localIP: string,
  localPort: number | undefined,
  protocol: Protocol,
): boolean {
  if (localPort === undefined) return false
  for (const port of state.listening.values()) {
    if (port.protocol !== protocol) continue
    if (port.port !== localPort) continue
    if (port.ip === localIP) return true
    if (port.ip === "0.0.0.0" || port.ip === "::") return true
  }
  return false
}

function applyPortListening(state: NetstatdState, event: PortListeningEvent, now: number): NetstatdState {
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

  for (const [cookie, conn] of state.connections) {
    if (conn.inbound) continue
    if (conn.protocol !== event.protocol) continue
    if (conn.localPort !== event.port) continue
    if (event.ip !== conn.localIP && event.ip !== "0.0.0.0" && event.ip !== "::") continue
    const flipped = syncAggregateForConnection(state, cookie, { ...conn, inbound: true }, now)
    state.connections.set(cookie, flipped)
  }

  return state
}

function applyProcessMetainfo(state: NetstatdState, event: ProcessMetainfoEvent): NetstatdState {
  const key = `${event.nodeName}:${event.pid}`
  state.processes.set(key, {
    key,
    pid: event.pid,
    nodeName: event.nodeName,
    netns: event.netns,
    isHostNetNS: event.isHostNetNS,
    cgroupSlice: event.cgroupSlice,
    containerUid: event.containerUid,
    exe: event.exe,
  })
  if (event.containerUid) {
    const set = state.pidByContainerUid.get(event.containerUid) ?? new Set<string>()
    set.add(key)
    state.pidByContainerUid.set(event.containerUid, set)
  }
  return state
}

function applyContainer(state: NetstatdState, event: ContainerEvent): NetstatdState {
  const prev = state.containersByUid.get(event.containerUid)
  const merged: ContainerInfo = {
    containerUid: event.containerUid,
    podUid: event.podUid ?? prev?.podUid,
    podName: event.podName ?? prev?.podName,
    namespace: event.namespace ?? prev?.namespace,
    containerName: event.containerName ?? prev?.containerName,
    image: event.image ?? prev?.image,
    nodeName: event.nodeName ?? prev?.nodeName,
  }
  state.containersByUid.set(event.containerUid, merged)
  if (merged.podUid) {
    const set = state.containersByPodUid.get(merged.podUid) ?? new Set<string>()
    set.add(event.containerUid)
    state.containersByPodUid.set(merged.podUid, set)
  }
  return state
}

function applyHostInfo(state: NetstatdState, event: HostInfoEvent): NetstatdState {
  if (!event.nodeName) return state
  state.hosts.set(event.nodeName, {
    nodeName: event.nodeName,
    hostIPs: new Set(event.hostIPs),
    hostNetNS: event.hostNetNS,
  })
  return state
}

function drainPending() {
  if (pendingEvents.length === 0) return
  const events = pendingEvents
  pendingEvents = []

  useNetstatd.setState(prev => {
    const state = { ...prev }
    state.containersByUid = new Map(prev.containersByUid)
    state.containersByPodUid = new Map(prev.containersByPodUid)
    state.processes = new Map(prev.processes)
    state.pidByContainerUid = new Map(prev.pidByContainerUid)
    state.pidBySockCookie = new Map(prev.pidBySockCookie)
    state.hosts = new Map(prev.hosts)
    state.connections = new Map(prev.connections)
    state.listening = new Map(prev.listening)
    state.aggregates = new Map(prev.aggregates)
    state.cookieToAgg = new Map(prev.cookieToAgg)

    const now = Date.now()
    let lookupChanged = false

    for (const event of events) {
      state.rawEventCount++
      switch (event.type) {
        case "container.added":
        case "container.metainfo":
          applyContainer(state, event)
          lookupChanged = true
          break
        case "process.metainfo":
          applyProcessMetainfo(state, event)
          lookupChanged = true
          break
        case "host.info":
          applyHostInfo(state, event)
          lookupChanged = true
          break
        case "connection.event":
        case "connection.accepted": {
          const verdict = isOursOrPending(event, state)
          if (verdict === "ours") applyConnectionEvent(state, event, now)
          else if (verdict === "pending") holdingBuffer.push({ event, receivedAt: now })
          break
        }
        case "port.listening": {
          const verdict = isOursOrPending(event, state)
          if (verdict === "ours") applyPortListening(state, event, now)
          else if (verdict === "pending") holdingBuffer.push({ event, receivedAt: now })
          break
        }
      }
    }

    if (lookupChanged) replayHoldingBuffer(state, now)

    state.lastFlushedAt = now
    state.revision = prev.revision + 1
    return state
  })
}

function replayHoldingBuffer(state: NetstatdState, now: number) {
  const next: typeof holdingBuffer = []
  for (const item of holdingBuffer) {
    if (now - item.receivedAt > HOLDING_BUFFER_MS) continue
    const verdict = isOursOrPending(item.event, state)
    if (verdict === "ours") {
      if (item.event.type === "port.listening") applyPortListening(state, item.event, now)
      else applyConnectionEvent(state, item.event, now)
    } else if (verdict === "pending") {
      next.push(item)
    }
  }
  holdingBuffer = next
}

function prune() {
  useNetstatd.setState(prev => {
    const now = Date.now()
    holdingBuffer = holdingBuffer.filter(item => now - item.receivedAt <= HOLDING_BUFFER_MS)

    let mutated = false
    let connections = prev.connections
    let aggregates = prev.aggregates
    let cookieToAgg = prev.cookieToAgg

    if (connections.size > CONN_CAP) {
      const sorted = [...connections.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      const toDrop = sorted.length - CONN_CAP
      connections = new Map(connections)
      for (let i = 0; i < toDrop; i++) connections.delete(sorted[i][0])
      mutated = true
    }

    if (aggregates.size > AGG_CAP) {
      const sorted = [...aggregates.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      const toDrop = sorted.length - AGG_CAP
      aggregates = new Map(aggregates)
      const dropped = new Set<string>()
      for (let i = 0; i < toDrop; i++) {
        aggregates.delete(sorted[i][0])
        dropped.add(sorted[i][0])
      }
      cookieToAgg = new Map(cookieToAgg)
      for (const [cookie, aggKey] of cookieToAgg) {
        if (dropped.has(aggKey)) cookieToAgg.delete(cookie)
      }
      mutated = true
    }

    if (cookieToAgg.size > COOKIE_AGG_CAP) {
      const excess = cookieToAgg.size - COOKIE_AGG_CAP
      cookieToAgg = new Map(cookieToAgg)
      const it = cookieToAgg.keys()
      for (let i = 0; i < excess; i++) {
        const next = it.next()
        if (next.done) break
        cookieToAgg.delete(next.value)
      }
      mutated = true
    }

    if (!mutated) return prev
    return { ...prev, connections, aggregates, cookieToAgg, revision: prev.revision + 1 }
  })
}

function refilterAfterScopeChange() {
  useNetstatd.setState(prev => {
    const keptConnections = new Map<string, Connection>()
    const droppedCookies: string[] = []
    for (const [key, c] of prev.connections) {
      const isOurs =
        scope.podIPs.has(c.localIP) ||
        scope.podIPs.has(c.remoteIP) ||
        (c.pid !== undefined && c.nodeName && (() => {
          const proc = prev.processes.get(`${c.nodeName}:${c.pid}`)
          if (!proc?.containerUid) return false
          const ci = prev.containersByUid.get(proc.containerUid)
          return ci?.podUid !== undefined && scope.podUids.has(ci.podUid)
        })())
      if (isOurs) keptConnections.set(key, c)
      else droppedCookies.push(key)
    }

    if (droppedCookies.length === 0) return prev

    const cookieToAgg = new Map(prev.cookieToAgg)
    const aggregates = new Map(prev.aggregates)
    for (const cookie of droppedCookies) {
      const aggKey = cookieToAgg.get(cookie)
      if (aggKey) {
        const existing = aggregates.get(aggKey)
        if (existing) {
          if (existing.count <= 1) aggregates.delete(aggKey)
          else aggregates.set(aggKey, { ...existing, count: existing.count - 1 })
        }
        cookieToAgg.delete(cookie)
      }
    }

    return { ...prev, connections: keptConnections, aggregates, cookieToAgg, revision: prev.revision + 1 }
  })
}

function connect() {
  const state = useNetstatd.getState()
  if (state.status === "connecting" || state.status === "open") return

  useNetstatd.setState({ status: "connecting", error: null })

  fetchNetstatdUrl()
    .then(url => {
      if (!url) {
        useNetstatd.setState({ status: "error", error: "Netstatd not configured" })
        return
      }
      const wsUrl = url
        .replace(/\/$/, "")
        .replace(/^http:\/\//, "ws://")
        .replace(/^https:\/\//, "wss://")
      try {
        socket = new WebSocket(`${wsUrl}/conntrack`)
      } catch (e) {
        useNetstatd.setState({ status: "error", error: String(e) })
        return
      }

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
      useNetstatd.setState({ status: "error", error: String(e) })
    })
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
  if (socket !== null) {
    socket.onclose = null
    socket.close()
    socket = null
  }
  if (scopeUnsub !== null) {
    scopeUnsub()
    scopeUnsub = null
  }
  pendingEvents = []
  holdingBuffer = []
  reconnectAttempt = 0
  currentWorkloadUid = null
  scope = { podUids: new Set(), podIPs: new Set(), containerUidByPodUid: new Map() }
  useNetstatd.setState(initial())
}

export function openNetstatdSession(workloadUid: string): () => void {
  refCount++
  if (refCount === 1) {
    currentWorkloadUid = workloadUid
    recomputeScope()
    scopeUnsub = useClusterState.subscribe(s => {
      void s
      const before = scope
      recomputeScope()
      if (
        before.podUids.size !== scope.podUids.size ||
        before.podIPs.size !== scope.podIPs.size ||
        ![...scope.podUids].every(u => before.podUids.has(u)) ||
        ![...scope.podIPs].every(ip => before.podIPs.has(ip))
      ) {
        refilterAfterScopeChange()
      }
    })
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS)
    connect()
  } else if (currentWorkloadUid !== workloadUid) {
    currentWorkloadUid = workloadUid
    recomputeScope()
    refilterAfterScopeChange()
  }

  return () => {
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0) teardown()
  }
}
