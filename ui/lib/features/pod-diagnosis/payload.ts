import "server-only"

import { getResourceObject } from "@/lib/cluster-resources/resource-object"
import { getPodEvents } from "@/lib/cluster-resources/events"
import { getPodLogs } from "@/lib/features/logs/pod"
import type { LogLine } from "@/lib/features/logs/types"
import type { PodEvent } from "@/lib/cluster-resources/types"
import { failingContainer } from "./signature"
import type { DiagnosisFacts } from "./types"

const LOG_LINES = 60
const RELATED_PODS_MAX = 12
const LOG_LINE_CHARS = 200
const PAYLOAD_LOG_LINES = 40
const PAYLOAD_LOG_LINE_CHARS = 200
const PAYLOAD_MAX_CHARS = 16_000
const EVENTS_MAX = 15

type CollectedLine = { ts: string; message: string }
type CollectedLogs = Record<string, { currentSource: string | null; current: CollectedLine[]; previous: CollectedLine[] }>

export type PodObject = {
  metadata?: { managedFields?: unknown; labels?: Record<string, string>; creationTimestamp?: string }
  spec?: {
    restartPolicy?: string
    serviceAccountName?: string
    imagePullSecrets?: { name: string }[]
    nodeSelector?: Record<string, string>
    tolerations?: RawToleration[]
    affinity?: RawAffinity
    containers?: RawContainer[]
    initContainers?: RawContainer[]
    volumes?: RawVolume[]
  }
} & Record<string, unknown>

type RawToleration = { key?: string; operator?: string; value?: string; effect?: string }

type RawSelectorRequirement = { key: string; operator: string; values?: string[] }
type RawAffinity = {
  nodeAffinity?: {
    requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms?: { matchExpressions?: RawSelectorRequirement[] }[] }
  }
  podAntiAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { topologyKey?: string }[] }
  podAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { topologyKey?: string }[] }
}

type RawProbe = {
  httpGet?: { path?: string; port?: number | string }
  tcpSocket?: { port?: number | string }
  exec?: { command?: string[] }
  initialDelaySeconds?: number
  periodSeconds?: number
  timeoutSeconds?: number
  failureThreshold?: number
}

type RawContainer = {
  name: string
  image?: string
  ports?: { containerPort?: number; name?: string; protocol?: string }[]
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> }
  env?: { name: string; valueFrom?: { secretKeyRef?: { name?: string }; configMapKeyRef?: { name?: string } } }[]
  envFrom?: { secretRef?: { name?: string }; configMapRef?: { name?: string } }[]
  livenessProbe?: RawProbe
  readinessProbe?: RawProbe
}

type RawVolume = {
  name: string
  secret?: { secretName?: string }
  configMap?: { name?: string }
  persistentVolumeClaim?: { claimName?: string }
}

type DiagnosisInputs = {
  object: PodObject | null
  events: PodEvent[]
  logs: CollectedLogs
}

type PayloadLogBlock = { container: string; run: "previous run" | "current run" | "identical in both runs"; lines: string[] }

export type DiagnosisPayload = {
  pod: string[]
  status: string[]
  spec: string[]
  events: string[]
  logs: PayloadLogBlock[]
  node: string[]
  siblings: string[]
  release: string[]
  metrics: string[]
  since: string | null
}

export async function collectDiagnosisInputs(facts: DiagnosisFacts, signal: AbortSignal): Promise<DiagnosisInputs> {
  const object = (await getResourceObject("Pod", facts.namespace, facts.name)) as PodObject | null
  if (object?.metadata) delete object.metadata.managedFields
  signal.throwIfAborted()

  const containers = [
    ...(object?.spec?.initContainers?.map(c => c.name) ?? []),
    ...(object?.spec?.containers?.map(c => c.name) ?? []),
  ]

  const [events, logs] = await Promise.all([
    getPodEvents(facts.namespace, facts.podUid).catch(() => [] as PodEvent[]),
    collectLogs(facts.namespace, facts.name, facts.podUid, containers),
  ])

  return { object, events, logs }
}

async function collectLogs(ns: string, pod: string, uid: string, containers: string[]): Promise<CollectedLogs> {
  const perContainer = await Promise.all(
    containers.map(async container => {
      const [current, previous] = await Promise.all([
        getPodLogs({ ns, pod, uid, container, sinceNs: null, limit: LOG_LINES }).catch(() => null),
        getPodLogs({ ns, pod, uid, container, sinceNs: null, limit: LOG_LINES, previous: true }).catch(() => null),
      ])
      return [container, {
        currentSource: current?.source ?? null,
        current: trim(current?.lines ?? []),
        previous: trim(previous?.lines ?? []),
      }] as const
    }),
  )
  return Object.fromEntries(perContainer)
}

function trim(lines: LogLine[]): CollectedLine[] {
  return lines.slice(-LOG_LINES).map(line => ({
    ts: new Date(line.tsMs).toISOString(),
    message: line.message.length > LOG_LINE_CHARS ? `${line.message.slice(0, LOG_LINE_CHARS)}…` : line.message,
  }))
}

function probeSummary(probe: RawProbe | undefined): string | null {
  if (!probe) return null
  const target = probe.httpGet
    ? `httpGet ${probe.httpGet.path ?? "/"}:${probe.httpGet.port ?? ""}`
    : probe.tcpSocket
      ? `tcp ${probe.tcpSocket.port ?? ""}`
      : probe.exec
        ? "exec"
        : "unknown"
  const timing = [
    probe.initialDelaySeconds !== undefined ? `initialDelay ${probe.initialDelaySeconds}s` : null,
    probe.periodSeconds !== undefined ? `period ${probe.periodSeconds}s` : null,
    `timeout ${probe.timeoutSeconds ?? 1}s`,
    probe.failureThreshold !== undefined ? `failureThreshold ${probe.failureThreshold}` : null,
  ].filter(Boolean).join(", ")
  return timing ? `${target} (${timing})` : target
}

function specLines(object: PodObject | null): string[] {
  const spec = object?.spec
  if (!spec) return []
  const lines: string[] = []
  const containers = [
    ...(spec.initContainers ?? []).map(c => ({ c, init: true })),
    ...(spec.containers ?? []).map(c => ({ c, init: false })),
  ]

  for (const { c, init } of containers) {
    const prefix = init ? `init container ${c.name}` : `container ${c.name}`
    lines.push(`${prefix} image ${c.image ?? "unknown"}`)
    const ports = (c.ports ?? []).filter(p => p.containerPort).map(p => `${p.containerPort}${p.name ? ` (${p.name})` : ""}`)
    if (ports.length > 0) lines.push(`${prefix} ports ${ports.join(", ")}`)
    const limits = c.resources?.limits
    const requests = c.resources?.requests
    if (limits && Object.keys(limits).length > 0) lines.push(`${prefix} limits ${Object.entries(limits).map(([k, v]) => `${k}=${v}`).join(" ")}`)
    if (requests && Object.keys(requests).length > 0) lines.push(`${prefix} requests ${Object.entries(requests).map(([k, v]) => `${k}=${v}`).join(" ")}`)
    else if (!limits) lines.push(`${prefix} no resource limits or requests set`)

    const secrets = new Set<string>()
    const configMaps = new Set<string>()
    for (const from of c.envFrom ?? []) {
      if (from.secretRef?.name) secrets.add(from.secretRef.name)
      if (from.configMapRef?.name) configMaps.add(from.configMapRef.name)
    }
    for (const env of c.env ?? []) {
      if (env.valueFrom?.secretKeyRef?.name) secrets.add(env.valueFrom.secretKeyRef.name)
      if (env.valueFrom?.configMapKeyRef?.name) configMaps.add(env.valueFrom.configMapKeyRef.name)
    }
    if (secrets.size > 0) lines.push(`${prefix} env Secrets ${[...secrets].join(", ")}`)
    if (configMaps.size > 0) lines.push(`${prefix} env ConfigMaps ${[...configMaps].join(", ")}`)

    const liveness = probeSummary(c.livenessProbe)
    const readiness = probeSummary(c.readinessProbe)
    if (liveness) lines.push(`${prefix} livenessProbe ${liveness}`)
    if (readiness) lines.push(`${prefix} readinessProbe ${readiness}`)
    if (!liveness && !readiness) lines.push(`${prefix} no probes configured`)
  }

  for (const volume of spec.volumes ?? []) {
    if (volume.secret?.secretName) lines.push(`volume ${volume.name} Secret ${volume.secret.secretName}`)
    if (volume.configMap?.name) lines.push(`volume ${volume.name} ConfigMap ${volume.configMap.name}`)
    if (volume.persistentVolumeClaim?.claimName) lines.push(`volume ${volume.name} PVC ${volume.persistentVolumeClaim.claimName}`)
  }

  const pullSecrets = spec.imagePullSecrets?.map(s => s.name).filter(Boolean) ?? []
  lines.push(pullSecrets.length > 0 ? `imagePullSecrets ${pullSecrets.join(", ")}` : "imagePullSecrets none")
  lines.push(`serviceAccount ${spec.serviceAccountName ?? "default"}`)
  lines.push(`restartPolicy ${spec.restartPolicy ?? "Always"}`)
  lines.push(`nodeSelector ${selectorText(spec.nodeSelector)}`)
  lines.push(`tolerations ${tolerationText(spec.tolerations)}`)
  const affinity = affinityLines(spec.affinity)
  if (affinity.length > 0) lines.push(...affinity)
  return lines
}

function selectorText(selector: Record<string, string> | undefined): string {
  const pairs = Object.entries(selector ?? {}).map(([key, value]) => `${key}=${value}`)
  return pairs.length > 0 ? pairs.join(", ") : "none"
}

function tolerationText(tolerations: RawToleration[] | undefined): string {
  if (!tolerations || tolerations.length === 0) return "none"
  return tolerations
    .map(t => `${t.key ?? "*"}${t.operator === "Exists" ? "" : `=${t.value ?? ""}`}${t.effect ? `:${t.effect}` : ""}`)
    .join(", ")
}

function affinityLines(affinity: RawAffinity | undefined): string[] {
  if (!affinity) return []
  const lines: string[] = []
  const terms = affinity.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []
  const required = terms.flatMap(term => term.matchExpressions ?? []).map(e => `${e.key} ${e.operator} ${(e.values ?? []).join("|")}`.trim())
  if (required.length > 0) lines.push(`required node affinity ${required.join(", ")}`)
  const antiKeys = (affinity.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []).map(t => t.topologyKey).filter(Boolean)
  if (antiKeys.length > 0) lines.push(`required pod anti-affinity on ${antiKeys.join(", ")}`)
  const affKeys = (affinity.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []).map(t => t.topologyKey).filter(Boolean)
  if (affKeys.length > 0) lines.push(`required pod affinity on ${affKeys.join(", ")}`)
  return lines
}

function statusLines(facts: DiagnosisFacts): string[] {
  const lines: string[] = [`phase display ${facts.podStatus.display}`, `ready ${facts.podStatus.ready}`, `restarts total ${facts.podStatus.restarts}`]
  if (facts.podStatus.message) lines.push(`pod message ${facts.podStatus.message}`)
  for (const container of facts.podStatus.containers) {
    const prefix = container.init ? `init container ${container.name}` : `container ${container.name}`
    lines.push(`${prefix} image ${container.image} ready ${container.ready} restarts ${container.restartCount}`)
    if (container.waiting) lines.push(`${prefix} waiting ${container.waiting.reason}${container.waiting.message ? `: ${container.waiting.message}` : ""}`)
    if (container.lastTerminated) {
      lines.push(`${prefix} last run terminated ${container.lastTerminated.reason} exit ${container.lastTerminated.exitCode}${container.lastTerminated.finishedAt ? ` at ${container.lastTerminated.finishedAt}` : ""}`)
    }
  }
  return lines
}

function collapse(lines: CollectedLine[]): string[] {
  const out: string[] = []
  let last: string | null = null
  let repeats = 0
  const flush = () => {
    if (last === null) return
    out.push(repeats > 1 ? `${last} (x${repeats})` : last)
  }
  for (const line of lines) {
    const message = line.message.trim()
    if (!message || /^\d{4}-\d{2}-\d{2}[t\s:.\d z+-]*$/i.test(message)) continue
    const capped = message.length > PAYLOAD_LOG_LINE_CHARS ? `${message.slice(0, PAYLOAD_LOG_LINE_CHARS)}…` : message
    if (capped === last) {
      repeats++
      continue
    }
    flush()
    last = capped
    repeats = 1
  }
  flush()
  return out.slice(-PAYLOAD_LOG_LINES)
}

function logBlocks(logs: CollectedLogs): PayloadLogBlock[] {
  const blocks: PayloadLogBlock[] = []
  for (const [container, entry] of Object.entries(logs)) {
    const previous = collapse(entry.previous)
    const current = collapse(entry.current)
    if (previous.length === 0 && current.length === 0) continue
    if (previous.length > 0 && current.length > 0 && previous.join("\n") === current.join("\n")) {
      blocks.push({ container, run: "identical in both runs", lines: previous })
      continue
    }
    if (previous.length > 0) blocks.push({ container, run: "previous run", lines: previous })
    else blocks.push({ container, run: "current run", lines: current })
  }
  return blocks
}

function charsOf(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

function fitLogsToBudget(blocks: PayloadLogBlock[], failing: string | null, spent: number): PayloadLogBlock[] {
  const ordered = [...blocks].sort((a, b) => Number(b.container === failing) - Number(a.container === failing))
  let remaining = PAYLOAD_MAX_CHARS - spent
  const kept: PayloadLogBlock[] = []
  for (const block of ordered) {
    if (remaining <= 0) break
    const lines: string[] = []
    for (const line of [...block.lines].reverse()) {
      if (charsOf(lines) + line.length + 1 > remaining) break
      lines.unshift(line)
    }
    if (lines.length === 0) continue
    remaining -= charsOf(lines)
    kept.push({ ...block, lines })
  }
  return blocks.filter(block => kept.some(k => k.container === block.container)).map(block => kept.find(k => k.container === block.container) ?? block)
}

function eventLines(events: PodEvent[]): string[] {
  if (events.length === 0) return []
  return events.slice(0, EVENTS_MAX).map(e => `${e.type} ${e.reason} x${e.count}${e.lastSeen ? ` last ${e.lastSeen}` : ""}: ${e.message}`)
}

function nodeLines(facts: DiagnosisFacts): string[] {
  if (!facts.node) return []
  const pressure = Object.entries(facts.node.pressure).filter(([, on]) => on).map(([kind]) => kind)
  return [
    `node ${facts.nodeName ?? "unknown"} ready ${facts.node.ready}, pressure now ${pressure.length > 0 ? pressure.join(" and ") : "none"}${facts.node.storageUsedPct !== null ? `, volume group ${facts.node.storageUsedPct}% used` : ""}`,
  ]
}

function siblingLines(facts: DiagnosisFacts): string[] {
  const states = Object.entries(facts.siblings.byState).map(([state, count]) => `${count} ${state}`).join(", ")
  const total = facts.siblings.total
  return [
    `${total} pod${total === 1 ? "" : "s"} under ${facts.ownerKind ?? "no owner"} ${facts.ownerName ?? ""}: this one ${facts.podStatus.display}${states ? `, others ${states}` : ", no other pods"}${facts.siblings.nodes.length > 0 ? `, other nodes ${facts.siblings.nodes.join(", ")}` : ""}`,
  ]
}

const PEER_ADDRESS = /\[([0-9a-f:]+)\](?::|\s+port\s+)\d+|\b(\d{1,3}(?:\.\d{1,3}){3})(?::|\s+port\s+)\d+/gi

function peerAddresses(logs: PayloadLogBlock[]): Set<string> {
  const found = new Set<string>()
  for (const block of logs) {
    for (const line of block.lines) {
      for (const match of line.matchAll(PEER_ADDRESS)) {
        const ip = match[1] ?? match[2]
        if (ip) found.add(ip.toLowerCase())
      }
    }
  }
  return found
}

function workloadPrefix(podName: string): string {
  return podName.replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, "").replace(/-\d+$/, "")
}

function contactedNames(facts: DiagnosisFacts, logs: PayloadLogBlock[]): Set<string> {
  const peers = peerAddresses(logs)
  const text = logs.flatMap(block => block.lines).join("\n").toLowerCase()
  const names = new Set<string>()
  for (const pod of facts.release) {
    if (pod.ips?.some(ip => peers.has(ip.toLowerCase()))) {
      names.add(pod.name)
      continue
    }
    const prefix = workloadPrefix(pod.name).toLowerCase()
    if (prefix.length >= 4 && mentionsName(text, prefix)) names.add(pod.name)
  }
  return names
}

function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text)
}

function releaseLines(facts: DiagnosisFacts, contacted: Set<string>): string[] {
  const relevant = facts.release.filter(pod => contacted.has(pod.name) || !pod.ready)
  return relevant
    .sort((a, b) => Number(contacted.has(b.name)) - Number(contacted.has(a.name)) || Number(a.ready) - Number(b.ready) || b.restarts - a.restarts)
    .slice(0, RELATED_PODS_MAX)
    .map(pod => `${pod.name} ${pod.state} ready ${pod.ready} ${pod.restarts} restarts${contacted.has(pod.name) ? " (this pod connects to it)" : ""}`)
}

function metricLines(facts: DiagnosisFacts): string[] {
  const m = facts.metrics
  if (!m) return []
  const lines: string[] = []
  if (m.memoryBytes !== null) lines.push(`memory usage ${Math.round(m.memoryBytes / 1024 / 1024)}Mi${m.memoryLimitBytes ? ` of limit ${Math.round(m.memoryLimitBytes / 1024 / 1024)}Mi` : ", no limit"}`)
  if (m.cpuCores !== null) lines.push(`cpu usage ${m.cpuCores.toFixed(2)} cores${m.cpuLimitCores ? ` of limit ${m.cpuLimitCores.toFixed(2)}` : ", no limit"}`)
  return lines
}

function sinceOf(facts: DiagnosisFacts, events: PodEvent[]): string | null {
  const candidates = [
    events.filter(e => e.type === "Warning").map(e => e.firstSeen).filter((s): s is string => Boolean(s)).sort()[0] ?? null,
    failingContainer(facts.podStatus)?.lastTerminated?.finishedAt ?? null,
    facts.createdAt,
  ].filter((s): s is string => Boolean(s))
  return candidates.sort()[0] ?? null
}

function podLines(facts: DiagnosisFacts): string[] {
  const manager = facts.manager.kind === "helm"
    ? `helm release ${facts.manager.name} in ${facts.manager.namespace}`
    : facts.manager.kind === "argo"
      ? `argo app ${facts.manager.name}`
      : facts.manager.kind === "k3s-chart"
        ? `k3s HelmChart ${facts.manager.name}, whose controller recreates this Job on every retry`
        : "no helm release or argo app"
  return [
    `namespace ${facts.namespace}`,
    `name ${facts.name}`,
    `owner ${facts.ownerKind ?? "none"} ${facts.ownerName ?? ""}`.trim(),
    `workload ${facts.topmostKind ?? "none"} ${facts.topmostName ?? ""}`.trim(),
    `managed by ${manager}`,
    `node ${facts.nodeName ?? "not scheduled"}`,
    `created ${facts.createdAt ?? "unknown"}`,
    `restarts ${facts.podStatus.restarts}`,
    `pods failing the same way under this owner ${facts.duplicates}`,
  ]
}

export function buildDiagnosisPayload(facts: DiagnosisFacts, inputs: DiagnosisInputs): DiagnosisPayload {
  const allLogs = logBlocks(inputs.logs)
  const contacted = contactedNames(facts, allLogs)
  const fixed = {
    pod: podLines(facts),
    status: statusLines(facts),
    spec: specLines(inputs.object),
    events: eventLines(inputs.events),
    node: nodeLines(facts),
    siblings: siblingLines(facts),
    release: releaseLines(facts, contacted),
    metrics: metricLines(facts),
  }
  const spent = Object.values(fixed).reduce((sum, lines) => sum + charsOf(lines), 0)
  const logs = fitLogsToBudget(allLogs, failingContainer(facts.podStatus)?.name ?? null, spent)
  return { ...fixed, logs, since: sinceOf(facts, inputs.events) }
}
