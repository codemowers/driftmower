import { create } from "zustand"
import { NETSTATD_STREAM_URL } from "@/lib/cluster/constants"
import { sandboxScopeNamespaces, useSandboxContext } from "@/lib/tenancy/sandbox-context"
import type {
  AggregateBucket,
  ConnDelta,
  DeltaFrame,
  ListeningPort,
  NetstatdState,
  SnapshotFrame,
  StatusFrame,
} from "./types"

const initial = (): NetstatdState => ({
  status: "idle",
  error: null,
  lastFlushedAt: null,
  aggregates: new Map(),
  listening: new Map(),
  hosts: new Map(),
  hiddenCount: 0,
  upstream: null,
})

export const useNetstatd = create<NetstatdState>(initial)

const PRUNE_INTERVAL_MS = 10_000
const AGG_CAP = 2_000
const LISTENING_CAP = 2_000
const FLUSH_DEBOUNCE_MS = 50
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000]

type PendingFrame =
  | { kind: "snapshot"; frame: SnapshotFrame }
  | { kind: "delta"; frame: DeltaFrame }

let source: EventSource | null = null
let refCount = 0
let currentWorkloadUid: string | null = null
let currentNamespaceKey: string | null = null
let sandboxUnsub: (() => void) | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let pruneTimer: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pending: PendingFrame[] = []

function namespaceKey(namespaces: string[] | null): string {
  return namespaces === null ? "*" : [...namespaces].sort().join(",")
}

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    drainPending()
  }, FLUSH_DEBOUNCE_MS)
}

function applyDelta(state: NetstatdState, delta: ConnDelta, now: number): void {
  const existing = state.aggregates.get(delta.key)
  if (existing) {
    const localIPs = existing.localIPs.has(delta.localIP)
      ? existing.localIPs
      : new Set(existing.localIPs).add(delta.localIP)
    state.aggregates.set(delta.key, {
      ...existing,
      peer: delta.peer,
      count: existing.count + delta.count,
      lastSeen: Math.max(existing.lastSeen, delta.lastSeen),
      localIPs,
    })
    return
  }
  const bucket: AggregateBucket = {
    key: delta.key,
    direction: delta.direction,
    peerIP: delta.peerIP,
    peer: delta.peer,
    port: delta.port,
    protocol: delta.protocol,
    count: delta.count,
    firstSeen: now,
    lastSeen: delta.lastSeen,
    localIPs: new Set([delta.localIP]),
  }
  state.aggregates.set(delta.key, bucket)
}

function applyListening(state: NetstatdState, ports: ListeningPort[]): void {
  for (const port of ports) state.listening.set(port.key, port)
}

function drainPending() {
  if (pending.length === 0) return
  const frames = pending
  pending = []

  useNetstatd.setState(prev => {
    const state: NetstatdState = {
      ...prev,
      aggregates: new Map(prev.aggregates),
      listening: new Map(prev.listening),
      hosts: new Map(prev.hosts),
    }
    const now = Date.now()

    for (const item of frames) {
      if (item.kind === "snapshot") {
        state.hosts = new Map(
          item.frame.hosts.map(h => [
            h.nodeName,
            { nodeName: h.nodeName, hostIPs: new Set(h.hostIPs), hostNetNS: h.hostNetNS },
          ]),
        )
        state.listening = new Map(item.frame.listening.map(p => [p.key, p]))
        continue
      }
      for (const host of item.frame.hosts ?? []) {
        state.hosts.set(host.nodeName, {
          nodeName: host.nodeName,
          hostIPs: new Set(host.hostIPs),
          hostNetNS: host.hostNetNS,
        })
      }
      applyListening(state, item.frame.listeningAdded ?? [])
      for (const key of item.frame.listeningRemoved ?? []) state.listening.delete(key)
      for (const delta of item.frame.conns ?? []) applyDelta(state, delta, now)
      if (item.frame.dropped) state.hiddenCount += item.frame.dropped
    }

    state.lastFlushedAt = now
    return state
  })
}

function prune() {
  useNetstatd.setState(prev => {
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

function closeSource() {
  if (source !== null) {
    source.onopen = null
    source.onerror = null
    try {
      source.close()
    } catch {
      // ignore
    }
    source = null
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function openSource() {
  if (currentWorkloadUid === null) return
  closeSource()

  const namespaces = sandboxScopeNamespaces(useSandboxContext.getState())
  currentNamespaceKey = namespaceKey(namespaces)

  const params = new URLSearchParams({ workload: currentWorkloadUid })
  if (namespaces !== null) params.set("ns", namespaces.join(","))

  useNetstatd.setState({ status: "connecting", error: null })

  const es = new EventSource(`${NETSTATD_STREAM_URL}?${params.toString()}`)
  source = es

  es.onopen = () => {
    reconnectAttempt = 0
    useNetstatd.setState({ status: "open", error: null })
  }

  es.addEventListener("snapshot", ev => {
    pending.push({ kind: "snapshot", frame: JSON.parse((ev as MessageEvent).data) as SnapshotFrame })
    scheduleFlush()
  })

  es.addEventListener("delta", ev => {
    pending.push({ kind: "delta", frame: JSON.parse((ev as MessageEvent).data) as DeltaFrame })
    scheduleFlush()
  })

  es.addEventListener("status", ev => {
    const frame = JSON.parse((ev as MessageEvent).data) as StatusFrame
    useNetstatd.setState({ upstream: frame.upstream })
  })

  // EventSource would silently reconnect without a fresh snapshot, so reconnects are driven here.
  es.onerror = () => {
    closeSource()
    if (refCount === 0) {
      useNetstatd.setState({ status: "closed" })
      return
    }
    useNetstatd.setState({ status: "closed" })
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (refCount > 0) openSource()
    }, delay)
  }
}

function resetAndReopen() {
  pending = []
  useNetstatd.setState(initial())
  reconnectAttempt = 0
  openSource()
}

function onSandboxChange() {
  if (refCount === 0) return
  const key = namespaceKey(sandboxScopeNamespaces(useSandboxContext.getState()))
  if (key === currentNamespaceKey) return
  resetAndReopen()
}

function teardown() {
  closeSource()
  if (pruneTimer !== null) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (sandboxUnsub !== null) {
    sandboxUnsub()
    sandboxUnsub = null
  }
  pending = []
  reconnectAttempt = 0
  currentWorkloadUid = null
  currentNamespaceKey = null
  useNetstatd.setState(initial())
}

export function openNetstatdSession(workloadUid: string): () => void {
  refCount++
  if (refCount === 1) {
    currentWorkloadUid = workloadUid
    sandboxUnsub = useSandboxContext.subscribe(onSandboxChange)
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS)
    resetAndReopen()
  } else if (currentWorkloadUid !== workloadUid) {
    currentWorkloadUid = workloadUid
    resetAndReopen()
  }

  return () => {
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0) teardown()
  }
}
