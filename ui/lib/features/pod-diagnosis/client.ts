import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { ClusterNodesResponse } from "@/lib/cluster-resources/types"
import type { NodeStorageMap } from "@/lib/features/prometheus/node-storage"
import { POD_DIAGNOSIS_URL } from "@/lib/cluster/constants"
import { readApiError } from "@/lib/utils/read-api-error"
import { buildDiagnosisFacts, diagnosisKey, isDiagnosable, ownerChainOf } from "./signature"
import type { DiagnoseResponse, DiagnosisFacts, DiagnosisState } from "./types"

export const MAX_PODS_PER_REQUEST = 200
const PREWARM_MIN_INTERVAL_MS = 60 * 1000

export type DiagnoseOutcome = DiagnoseResponse | { unavailable: string }

export async function postDiagnose(pods: DiagnosisFacts[], focus: boolean, force = false): Promise<DiagnoseOutcome> {
  const res = await fetch(POD_DIAGNOSIS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ focus, force, pods }),
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 503) return { unavailable: await readApiError(res) }
  if (!res.ok) throw new Error(await readApiError(res))
  return (await res.json()) as DiagnoseResponse
}

export async function postDiagnoseAll(pods: DiagnosisFacts[], focus: boolean, force = false): Promise<DiagnoseOutcome> {
  const merged: DiagnoseResponse = { results: {} }
  for (let i = 0; i < pods.length; i += MAX_PODS_PER_REQUEST) {
    const outcome = await postDiagnose(pods.slice(i, i + MAX_PODS_PER_REQUEST), focus, force)
    if ("unavailable" in outcome) return outcome
    Object.assign(merged.results, outcome.results)
  }
  return merged
}

const known = new Map<string, DiagnosisState>()

export function rememberDiagnoses(results: Record<string, DiagnosisState>): void {
  for (const [key, state] of Object.entries(results)) known.set(key, state)
}

export function recallDiagnosis(key: string): DiagnosisState | undefined {
  return known.get(key)
}

export function diagnosableFacts(
  resources: ClusterResource[],
  nodeDrift: ClusterNodesResponse | null,
  nodeStorage: NodeStorageMap | null,
  now = Date.now(),
): DiagnosisFacts[] {
  const byUid = new Map(resources.map(r => [r.uid, r]))
  const representatives = new Map<string, { pod: ClusterResource; count: number }>()

  for (const pod of resources) {
    if (pod.kind !== "Pod") continue
    const ownerKind = pod.ownerUID ? byUid.get(pod.ownerUID)?.kind ?? null : null
    if (!isDiagnosable(pod, ownerKind, now)) continue
    const facts = buildDiagnosisFacts(pod, resources, nodeDrift, nodeStorage, null)
    const existing = representatives.get(facts.key)
    if (!existing) {
      representatives.set(facts.key, { pod, count: 1 })
      continue
    }
    existing.count++
    if ((pod.podStatus?.restarts ?? 0) > (existing.pod.podStatus?.restarts ?? 0)) existing.pod = pod
  }

  return [...representatives.values()].map(({ pod, count }) => buildDiagnosisFacts(pod, resources, nodeDrift, nodeStorage, null, count))
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

let lastPrewarmAt = 0
let lastPrewarmResources: ClusterResource[] | null = null

export function prewarmDiagnoses(
  resources: ClusterResource[] | null,
  nodeDrift: ClusterNodesResponse | null,
  nodeStorage: NodeStorageMap | null,
): void {
  if (!resources || resources === lastPrewarmResources) return
  const now = Date.now()
  if (now - lastPrewarmAt < PREWARM_MIN_INTERVAL_MS) return
  lastPrewarmResources = resources
  lastPrewarmAt = now

  const pods = diagnosableFacts(resources, nodeDrift, nodeStorage, now)
  if (pods.length === 0) return
  void postDiagnoseAll(pods, false)
    .then(outcome => "results" in outcome && rememberDiagnoses(outcome.results))
    .catch(() => {
      lastPrewarmAt = 0
      lastPrewarmResources = null
    })
}
