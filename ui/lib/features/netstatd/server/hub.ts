import "server-only"

import { isPrivateOrSpecial } from "@/lib/utils/private-ip"
import type {
  AggregateDirection,
  ConnDelta,
  DeltaFrame,
  ListeningPort,
  Protocol,
  SnapshotFrame,
  UpstreamHealth,
} from "../types"
import {
  isLocalPortListening,
  netnsKey,
  ownerOfListening,
  ownerOfLocalEndpoint,
  peerKeyOf,
  peerOf,
  type AttributionTables,
  type ListeningRecord,
} from "./attribute"
import { redact } from "./authorize"
import { discoverNetstatdPods, NETSTATD_AGENT_PORT } from "./discovery"
import { buildIpIndex, hostPortKey, type IpIndex } from "./ip-index"
import { dialHost, normalizeIp } from "./normalize-ip"
import type { Subscriber } from "./subscribe"
import { parseUpstream, type ConnectionEvent, type PortListeningEvent } from "./upstream-events"

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const DISCOVER_INTERVAL_MS = 15_000
const INDEX_INTERVAL_MS = 10_000
const FLUSH_INTERVAL_MS = 250
const IDLE_LINGER_MS = 60_000
const MAX_BATCH_KEYS = 2_000

type Conn = {
  ip: string
  nodeName: string
  socket: WebSocket | null
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
  connected: boolean
  closing: boolean
}

type HubState = {
  conns: Map<string, Conn>
  listening: Map<string, ListeningRecord>
  tables: AttributionTables
  indexPromise: Promise<IpIndex> | null
  subscribers: Set<Subscriber>
  watchedIPs: Set<string>
  discoverTimer: ReturnType<typeof setInterval> | null
  indexTimer: ReturnType<typeof setInterval> | null
  flushTimer: ReturnType<typeof setInterval> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  started: boolean
}

const STATE_KEY = Symbol.for("driftmower.netstatd.hub")

function state(): HubState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: HubState }
  g[STATE_KEY] ??= {
    conns: new Map(),
    listening: new Map(),
    tables: {
      index: null,
      hosts: new Map(),
      containers: new Map(),
      netnsOwner: new Map(),
      listeningByPort: new Map(),
    },
    indexPromise: null,
    subscribers: new Set(),
    watchedIPs: new Set(),
    discoverTimer: null,
    indexTimer: null,
    flushTimer: null,
    idleTimer: null,
    started: false,
  }
  return g[STATE_KEY]
}

function listeningKey(nodeName: string, netns: number, protocol: string, ip: string, port: number): string {
  return `${nodeName}:${netns}:${protocol}:${ip}:${port}`
}

function toWire(record: ListeningRecord): ListeningPort {
  return {
    key: record.key,
    protocol: record.protocol,
    ip: record.ip,
    port: record.port,
    nodeName: record.nodeName,
    netns: record.netns,
    isHostNetNS: record.isHostNetNS,
    ...(record.ownerPodUid ? { ownerPodUid: record.ownerPodUid } : {}),
  }
}

function setListening(s: HubState, record: ListeningRecord): void {
  deleteListening(s, record.key)
  s.listening.set(record.key, record)
  const bucketKey = hostPortKey(record.nodeName, record.protocol, record.port)
  const bucket = s.tables.listeningByPort.get(bucketKey)
  if (bucket) bucket.push(record)
  else s.tables.listeningByPort.set(bucketKey, [record])
}

function deleteListening(s: HubState, key: string): void {
  const existing = s.listening.get(key)
  if (!existing) return
  s.listening.delete(key)
  const bucketKey = hostPortKey(existing.nodeName, existing.protocol, existing.port)
  const bucket = s.tables.listeningByPort.get(bucketKey)
  if (!bucket) return
  const next = bucket.filter(r => r.key !== key)
  if (next.length > 0) s.tables.listeningByPort.set(bucketKey, next)
  else s.tables.listeningByPort.delete(bucketKey)
}

function dropNode(s: HubState, nodeName: string): void {
  s.tables.hosts.delete(nodeName)
  for (const [key, record] of [...s.listening]) {
    if (record.nodeName !== nodeName) continue
    deleteListening(s, key)
    if (!record.ownerPodUid) continue
    for (const sub of s.subscribers) {
      if (!sub.scope.podUids.has(record.ownerPodUid)) continue
      sub.listeningAdded.delete(key)
      sub.listeningRemoved.add(key)
    }
  }
  for (const [key] of s.tables.netnsOwner) {
    if (key.startsWith(`${nodeName}:`)) s.tables.netnsOwner.delete(key)
  }
  for (const [uid, record] of s.tables.containers) {
    if (record.nodeName === nodeName) s.tables.containers.delete(uid)
  }
}

function queueConn(sub: Subscriber, delta: ConnDelta): void {
  const existing = sub.conns.get(delta.key)
  if (existing) {
    existing.count += delta.count
    existing.lastSeen = Math.max(existing.lastSeen, delta.lastSeen)
    return
  }
  // A busy workload is not a slow consumer: shed the excess keys instead of dropping the stream.
  if (sub.conns.size >= MAX_BATCH_KEYS) {
    sub.dropped++
    return
  }
  sub.conns.set(delta.key, delta)
}

function flushSubscriber(sub: Subscriber): void {
  if (sub.closed) return
  if (sub.conns.size === 0 && sub.listeningAdded.size === 0 && sub.listeningRemoved.size === 0) return

  const frame: DeltaFrame = {}
  if (sub.conns.size > 0) frame.conns = [...sub.conns.values()]
  if (sub.listeningAdded.size > 0) frame.listeningAdded = [...sub.listeningAdded.values()]
  if (sub.listeningRemoved.size > 0) frame.listeningRemoved = [...sub.listeningRemoved]
  if (sub.dropped > 0) frame.dropped = sub.dropped

  sub.conns.clear()
  sub.listeningAdded.clear()
  sub.listeningRemoved.clear()
  sub.dropped = 0

  sub.write("delta", frame)
}

function recomputeWatched(s: HubState): void {
  const ips = new Set<string>()
  for (const sub of s.subscribers) {
    for (const ip of sub.scope.podIPs) ips.add(ip)
  }
  s.watchedIPs = ips
}

function applyListening(s: HubState, event: PortListeningEvent, nodeName: string): void {
  const ip = normalizeIp(event.ip)
  const key = listeningKey(nodeName, event.netns, event.protocol, ip, event.port)
  const record: ListeningRecord = {
    key,
    protocol: event.protocol,
    ip,
    port: event.port,
    nodeName,
    netns: event.netns,
    isHostNetNS: event.isHostNetNS,
  }
  record.ownerPodUid = ownerOfListening(s.tables, record)
  setListening(s, record)
  if (record.ownerPodUid) publishListening(s, record)
}

function backfillNetns(s: HubState, nodeName: string, netns: number): void {
  for (const record of s.listening.values()) {
    if (record.nodeName !== nodeName || record.netns !== netns || record.ownerPodUid) continue
    const owner = ownerOfListening(s.tables, record)
    if (!owner) continue
    record.ownerPodUid = owner
    publishListening(s, record)
  }
}

function publishListening(s: HubState, record: ListeningRecord): void {
  if (!record.ownerPodUid) return
  const wire = toWire(record)
  for (const sub of s.subscribers) {
    if (!sub.scope.podUids.has(record.ownerPodUid)) continue
    sub.listeningRemoved.delete(wire.key)
    sub.listeningAdded.set(wire.key, wire)
  }
}

function handleConnection(s: HubState, event: ConnectionEvent, nodeName: string): void {
  const localIP = normalizeIp(event.localIP)
  const peerIP = normalizeIp(event.remoteIP)
  if (!localIP || !peerIP) return
  if (s.watchedIPs.size > 0 && !s.watchedIPs.has(localIP)) return

  const t = s.tables
  const owner = ownerOfLocalEndpoint(t, nodeName, localIP, event.localPort, event.protocol)
  if (!owner) return

  let direction: AggregateDirection
  let port: number | undefined
  if (event.type === "connection.accepted") {
    direction = "inbound"
    port = event.localPort
  } else if (isLocalPortListening(t, nodeName, localIP, event.localPort, event.protocol)) {
    direction = "inbound"
    port = event.localPort
  } else {
    direction = "outbound"
    port = event.remotePort
  }
  if (port === undefined) return

  // Only an outbound connection's port belongs to the peer; an inbound one is the client's ephemeral port.
  const peerPort = direction === "outbound" ? port : undefined
  const peer = peerOf(t, peerIP, peerPort, event.protocol, isPrivateOrSpecial(peerIP))
  const now = Date.now()
  const dir = direction === "inbound" ? "in" : "out"

  for (const sub of s.subscribers) {
    if (!sub.scope.podUids.has(owner.podUid)) continue
    const shown = redact(sub.viewer, peer)
    const delta: ConnDelta = {
      key: `${dir}:${peerKeyOf(shown, peerIP)}:${port}:${event.protocol}`,
      direction,
      localIP,
      peerIP,
      peer: shown,
      port,
      protocol: event.protocol as Protocol,
      count: 1,
      lastSeen: now,
    }
    queueConn(sub, delta)
  }
}

function handleFrame(s: HubState, conn: Conn, raw: string): void {
  const event = parseUpstream(raw)
  if (!event) return
  const nodeName = event.nodeName || conn.nodeName

  switch (event.type) {
    case "host.info":
      s.tables.hosts.set(nodeName, {
        nodeName,
        hostIPs: new Set((event.hostIPs ?? []).map(normalizeIp).filter(Boolean)),
        hostNetNS: event.hostNetNS,
      })
      break
    case "container.added":
    case "container.metainfo":
      s.tables.containers.set(event.containerUid, {
        podUid: event.podUid,
        namespace: event.namespace,
        podName: event.podName,
        nodeName,
      })
      break
    case "container.deleted":
      s.tables.containers.delete(event.containerUid)
      break
    case "process.metainfo":
      if (event.containerUid && !event.isHostNetNS) {
        s.tables.netnsOwner.set(netnsKey(nodeName, event.netns), event.containerUid)
        backfillNetns(s, nodeName, event.netns)
      }
      break
    case "port.listening":
      applyListening(s, event, nodeName)
      break
    case "connection.event":
    case "connection.accepted":
      handleConnection(s, event, nodeName)
      break
  }
}

function connectPod(s: HubState, conn: Conn): void {
  if (conn.closing) return
  let socket: WebSocket
  try {
    socket = new WebSocket(`ws://${dialHost(conn.ip)}:${NETSTATD_AGENT_PORT}/conntrack?match=any`)
  } catch (e) {
    console.error(`[netstatd-hub] dial failed ${conn.nodeName}:`, e)
    scheduleReconnect(s, conn)
    return
  }
  conn.socket = socket

  socket.onopen = () => {
    conn.connected = true
    conn.attempt = 0
    console.log(`[netstatd-hub] connected ${conn.nodeName} (${conn.ip})`)
  }
  socket.onmessage = ev => {
    if (typeof ev.data === "string") handleFrame(s, conn, ev.data)
  }
  socket.onerror = () => {}
  socket.onclose = () => {
    conn.socket = null
    if (conn.connected) console.log(`[netstatd-hub] disconnected ${conn.nodeName}`)
    conn.connected = false
    dropNode(s, conn.nodeName)
    scheduleReconnect(s, conn)
  }
}

function scheduleReconnect(s: HubState, conn: Conn): void {
  if (conn.closing || conn.timer !== null) return
  const delay = RECONNECT_BACKOFF_MS[Math.min(conn.attempt, RECONNECT_BACKOFF_MS.length - 1)]
  conn.attempt++
  conn.timer = setTimeout(() => {
    conn.timer = null
    if (!conn.closing) connectPod(s, conn)
  }, delay)
}

function closeConn(s: HubState, conn: Conn): void {
  conn.closing = true
  if (conn.timer !== null) {
    clearTimeout(conn.timer)
    conn.timer = null
  }
  if (conn.socket) {
    conn.socket.onclose = null
    conn.socket.onmessage = null
    conn.socket.onerror = null
    conn.socket.onopen = null
    try {
      conn.socket.close()
    } catch {}
    conn.socket = null
  }
  s.conns.delete(conn.ip)
  dropNode(s, conn.nodeName)
}

async function refreshPods(s: HubState): Promise<void> {
  let pods
  try {
    pods = await discoverNetstatdPods()
  } catch (e) {
    console.error("[netstatd-hub] pod discovery failed:", e)
    return
  }

  const seen = new Set<string>()
  for (const pod of pods) {
    seen.add(pod.ip)
    if (s.conns.has(pod.ip)) continue
    const conn: Conn = {
      ip: pod.ip,
      nodeName: pod.nodeName,
      socket: null,
      attempt: 0,
      timer: null,
      connected: false,
      closing: false,
    }
    s.conns.set(pod.ip, conn)
    connectPod(s, conn)
  }
  for (const conn of [...s.conns.values()]) {
    if (!seen.has(conn.ip)) closeConn(s, conn)
  }
}

async function refreshIndex(s: HubState): Promise<IpIndex> {
  if (s.indexPromise) return s.indexPromise
  const promise = buildIpIndex()
    .then(index => {
      s.tables.index = index
      return index
    })
    .catch(e => {
      console.error("[netstatd-hub] index build failed:", e)
      throw e
    })
    .finally(() => {
      s.indexPromise = null
    })
  s.indexPromise = promise
  return promise
}

function flushAll(s: HubState): void {
  for (const sub of s.subscribers) flushSubscriber(sub)
}

function startTimers(s: HubState): void {
  if (s.started) return
  s.started = true
  s.discoverTimer = setInterval(() => void refreshPods(s), DISCOVER_INTERVAL_MS)
  s.indexTimer = setInterval(() => void refreshIndex(s).catch(() => {}), INDEX_INTERVAL_MS)
  s.flushTimer = setInterval(() => flushAll(s), FLUSH_INTERVAL_MS)
}

function stopHub(s: HubState): void {
  if (s.discoverTimer) clearInterval(s.discoverTimer)
  if (s.indexTimer) clearInterval(s.indexTimer)
  if (s.flushTimer) clearInterval(s.flushTimer)
  s.discoverTimer = null
  s.indexTimer = null
  s.flushTimer = null
  s.started = false
  for (const conn of [...s.conns.values()]) closeConn(s, conn)
  s.tables.hosts.clear()
  s.tables.containers.clear()
  s.tables.netnsOwner.clear()
  s.listening.clear()
  console.log("[netstatd-hub] stopped, no subscribers")
}

export async function ensureIndex(): Promise<IpIndex> {
  const s = state()
  if (s.tables.index) return s.tables.index
  return refreshIndex(s)
}

export async function addSubscriber(sub: Subscriber): Promise<void> {
  const s = state()
  if (s.idleTimer !== null) {
    clearTimeout(s.idleTimer)
    s.idleTimer = null
  }
  s.subscribers.add(sub)
  recomputeWatched(s)

  if (!s.started) {
    startTimers(s)
    await refreshIndex(s).catch(() => {})
    await refreshPods(s)
  }
}

export function removeSubscriber(sub: Subscriber): void {
  const s = state()
  s.subscribers.delete(sub)
  recomputeWatched(s)
  if (s.subscribers.size > 0 || s.idleTimer !== null) return
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null
    if (state().subscribers.size === 0) stopHub(state())
  }, IDLE_LINGER_MS)
}

export function snapshotFor(sub: Subscriber): SnapshotFrame {
  const s = state()
  const hosts = [...s.tables.hosts.values()].map(h => ({
    nodeName: h.nodeName,
    hostIPs: [...h.hostIPs],
    hostNetNS: h.hostNetNS,
  }))
  const listening: ListeningPort[] = []
  for (const record of s.listening.values()) {
    if (!record.ownerPodUid || !sub.scope.podUids.has(record.ownerPodUid)) continue
    listening.push(toWire(record))
  }
  return { hosts, listening }
}

export function upstreamHealth(): UpstreamHealth {
  const s = state()
  let connected = 0
  for (const conn of s.conns.values()) if (conn.connected) connected++
  return { total: s.conns.size, connected }
}

export function indexBuiltAt(): number {
  return state().tables.index?.builtAt ?? 0
}
