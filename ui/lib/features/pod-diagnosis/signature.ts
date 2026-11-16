import type { ClusterResource, PodContainerStatus, PodStatus } from "@/lib/cluster/cluster-state"
import type { ClusterNodesResponse } from "@/lib/cluster-resources/types"
import type { NodeStorageMap } from "@/lib/features/prometheus/node-storage"
import type { PodMetrics } from "@/lib/features/prometheus/pod-metrics"
import { classifyPod } from "@/lib/cluster/styles/pod-status-style"
import { K3S_CHART_LABEL, PROMPT_VERSION, type DiagnosisFacts, type ManagerFacts, type ReleasePod } from "./types"

const QUIET_PENDING_MS = 5 * 60 * 1000
const JOB_ERROR_MIN_AGE_MS = 10 * 60 * 1000
const OWNER_CHAIN_MAX = 6
const RELEASE_PODS_MAX = 30
const SIBLING_NODES_MAX = 10
const MESSAGE_MAX_CHARS = 200

const STARTING_REASONS = new Set(["ContainerCreating", "PodInitializing"])
const JOB_ERROR_REASONS = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError"])

export function failingContainer(podStatus: PodStatus): PodContainerStatus | null {
  const containers = podStatus.containers
  if (containers.length === 0) return null
  return (
    containers.find(c => c.waiting && !STARTING_REASONS.has(c.waiting.reason))
    ?? containers.find(c => c.lastTerminated)
    ?? containers.find(c => !c.ready)
    ?? containers[0]
  )
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const HEX_DIGEST = /\b[0-9a-f]{12,}\b/g

export function normalizeMessage(text: string, podName?: string): string {
  let out = text.toLowerCase()
  if (podName) out = out.split(podName.toLowerCase()).join("#")
  return out
    .replace(UUID, "#")
    .replace(HEX_DIGEST, "#")
    .replace(/\d+(\.\d+)?\s*[kmgt]?i?b?/g, "#")
    .replace(/#(?:[-_.]?#)+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE_MAX_CHARS)
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function diagnosisKey(pod: ClusterResource): string {
  const podStatus = pod.podStatus
  const container = podStatus ? failingContainer(podStatus) : null
  const display = podStatus?.display ?? pod.phase ?? "Unknown"
  const message = container?.waiting?.message ?? podStatus?.message ?? ""
  const shape = [
    container?.waiting?.reason ?? "",
    container?.lastTerminated?.reason ?? "",
    container?.lastTerminated?.exitCode ?? "",
    hashText(normalizeMessage(message, pod.name)),
  ].join("|")
  return `v${PROMPT_VERSION}:pod-failure:${pod.ownerUID ?? pod.uid}:${container?.image ?? ""}:${display}|${shape}`
}

function ageMs(pod: ClusterResource, now: number): number {
  if (!pod.createdAt) return Number.POSITIVE_INFINITY
  const created = Date.parse(pod.createdAt)
  return Number.isFinite(created) ? now - created : Number.POSITIVE_INFINITY
}

export function isDiagnosable(pod: ClusterResource, ownerKind: string | null, now: number): boolean {
  if (pod.kind !== "Pod" || !pod.podStatus) return false
  const podStatus = pod.podStatus
  const severity = classifyPod(pod)
  if (severity === "succeeded" || podStatus.display === "Terminating") return false

  const container = failingContainer(podStatus)
  const waitingReason = container?.waiting?.reason ?? null
  const erroring = waitingReason !== null && !STARTING_REASONS.has(waitingReason)
  const age = ageMs(pod, now)

  if (ownerKind === "Job") {
    if (waitingReason && JOB_ERROR_REASONS.has(waitingReason)) return true
    return (severity === "failed" || severity === "unknown") && age > JOB_ERROR_MIN_AGE_MS
  }

  if (severity === "failed" || severity === "unknown") return true
  if (erroring) return true
  if (!podStatus.ready && podStatus.restarts > 0) return true
  if (severity === "pending") return age > QUIET_PENDING_MS
  return false
}

export function parseHelmManager(managerUID: string | undefined): { namespace: string; name: string } | null {
  if (!managerUID?.startsWith("helm-release:")) return null
  const [, namespace, name] = managerUID.split(":")
  return namespace && name ? { namespace, name } : null
}

export function ownerChainOf(pod: ClusterResource, byUid: Map<string, ClusterResource>): ClusterResource[] {
  const chain: ClusterResource[] = []
  let cursor = pod.ownerUID ? byUid.get(pod.ownerUID) : undefined
  while (cursor && chain.length < OWNER_CHAIN_MAX) {
    chain.push(cursor)
    cursor = cursor.ownerUID ? byUid.get(cursor.ownerUID) : undefined
  }
  return chain
}

function managerFacts(pod: ClusterResource, topmost: ClusterResource | null): ManagerFacts {
  const helm = parseHelmManager(pod.managerUID ?? topmost?.managerUID)
  if (helm) return { kind: "helm", namespace: helm.namespace, name: helm.name }
  const argoApp = pod.argoApp ?? topmost?.argoApp
  if (argoApp) return { kind: "argo", name: argoApp.name }
  const chart = pod.labels?.[K3S_CHART_LABEL]
  if (chart) return { kind: "k3s-chart", namespace: pod.namespace, name: chart }
  return { kind: "none" }
}

function podState(pod: ClusterResource): string {
  return pod.podStatus?.display ?? pod.phase ?? "Unknown"
}

function relatedPods(pod: ClusterResource, resources: ClusterResource[], managerUID: string | undefined): ReleasePod[] {
  const related = resources.filter(r => {
    if (r.kind !== "Pod" || r.uid === pod.uid || r.ownerUID === pod.ownerUID) return false
    if (managerUID && r.managerUID === managerUID) return true
    if (r.namespace !== pod.namespace) return false
    return r.podStatus?.ready === false || (r.ips?.length ?? 0) > 0
  })
  return related
    .map(r => ({ name: r.name, state: podState(r), ready: r.podStatus?.ready ?? false, restarts: r.podStatus?.restarts ?? 0, ips: r.ips }))
    .sort((a, b) => Number(a.ready) - Number(b.ready) || b.restarts - a.restarts)
    .slice(0, RELEASE_PODS_MAX)
}

export function buildDiagnosisFacts(
  pod: ClusterResource,
  resources: ClusterResource[],
  nodeDrift: ClusterNodesResponse | null,
  nodeStorage: NodeStorageMap | null,
  metrics: PodMetrics | null,
  duplicates = 1,
): DiagnosisFacts {
  const byUid = new Map(resources.map(r => [r.uid, r]))
  const chain = ownerChainOf(pod, byUid)
  const owner = chain[0] ?? null
  const topmost = chain[chain.length - 1] ?? null

  const siblingPods = resources.filter(r => r.kind === "Pod" && r.uid !== pod.uid && r.ownerUID && r.ownerUID === pod.ownerUID)
  const byState: Record<string, number> = {}
  for (const sibling of siblingPods) {
    const state = podState(sibling)
    byState[state] = (byState[state] ?? 0) + 1
  }
  const nodes = [...new Set(siblingPods.map(r => r.nodeName).filter((n): n is string => Boolean(n)))].slice(0, SIBLING_NODES_MAX)

  const node = pod.nodeName ? nodeDrift?.nodes.find(n => n.name === pod.nodeName) ?? null : null
  // Evictions follow the node's ephemeral storage, not its LVM pool.
  const storage = pod.nodeName ? nodeStorage?.[pod.nodeName]?.ephemeral ?? null : null

  return {
    key: diagnosisKey(pod),
    podUid: pod.uid,
    namespace: pod.namespace,
    name: pod.name,
    nodeName: pod.nodeName ?? null,
    ownerKind: owner?.kind ?? null,
    ownerName: owner?.name ?? null,
    ownerUid: owner?.uid ?? null,
    topmostKind: topmost?.kind ?? null,
    topmostName: topmost?.name ?? null,
    topmostUid: topmost?.uid ?? null,
    manager: managerFacts(pod, topmost),
    podStatus: pod.podStatus ?? { display: podState(pod), ready: false, restarts: 0, message: null, containers: [] },
    createdAt: pod.createdAt ?? null,
    duplicates,
    siblings: { total: siblingPods.length + 1, byState, nodes },
    release: relatedPods(pod, resources, pod.managerUID ?? topmost?.managerUID),
    node: node ? { ready: node.readiness === "Ready", pressure: node.pressure, storageUsedPct: storage && storage.total > 0 ? Math.round((storage.used / storage.total) * 100) : null } : null,
    metrics: metrics
      ? {
          memoryBytes: metrics.memory.usage,
          memoryLimitBytes: metrics.memory.limit,
          cpuCores: metrics.cpu.usage,
          cpuLimitCores: metrics.cpu.limit,
        }
      : null,
  }
}

export function duplicatesFor(pod: ClusterResource, resources: ClusterResource[], now = Date.now()): number {
  const byUid = new Map(resources.map(r => [r.uid, r]))
  const key = diagnosisKey(pod)
  let count = 0
  for (const other of resources) {
    if (other.kind !== "Pod") continue
    const ownerKind = other.ownerUID ? byUid.get(other.ownerUID)?.kind ?? null : null
    if (!isDiagnosable(other, ownerKind, now)) continue
    if (diagnosisKey(other) === key) count++
  }
  return Math.max(1, count)
}

export function ownerKindOf(pod: ClusterResource, resources: ClusterResource[]): string | null {
  const byUid = new Map(resources.map(r => [r.uid, r]))
  return ownerChainOf(pod, byUid)[0]?.kind ?? null
}
