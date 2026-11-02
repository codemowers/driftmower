import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { POD_DIAGNOSIS_URL } from "@/lib/cluster/constants"
import { readApiError } from "@/lib/utils/read-api-error"
import type { DiagnoseRequest, DiagnoseResponse, DiagnosisState } from "./types"

const PREWARM_MIN_INTERVAL_MS = 60 * 1000

export type DiagnoseOutcome = DiagnoseResponse | { unavailable: string }

async function postDiagnose(body: DiagnoseRequest): Promise<DiagnoseOutcome> {
  const res = await fetch(POD_DIAGNOSIS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 503) return { unavailable: await readApiError(res) }
  if (!res.ok) throw new Error(await readApiError(res))
  return (await res.json()) as DiagnoseResponse
}

export function diagnosePod(podUid: string, force: boolean): Promise<DiagnoseOutcome> {
  return postDiagnose({ podUid, force })
}

const known = new Map<string, DiagnosisState>()

export function rememberDiagnoses(results: Record<string, DiagnosisState>): void {
  for (const [key, state] of Object.entries(results)) known.set(key, state)
}

export function recallDiagnosis(key: string): DiagnosisState | undefined {
  return known.get(key)
}

let lastPrewarmAt = 0
let lastPrewarmResources: ClusterResource[] | null = null

export function prewarmDiagnoses(resources: ClusterResource[] | null): void {
  if (!resources || resources === lastPrewarmResources) return
  const now = Date.now()
  if (now - lastPrewarmAt < PREWARM_MIN_INTERVAL_MS) return
  lastPrewarmResources = resources
  lastPrewarmAt = now

  void postDiagnose({ prewarm: true })
    .then(outcome => "results" in outcome && rememberDiagnoses(outcome.results))
    .catch(() => {
      lastPrewarmAt = 0
      lastPrewarmResources = null
    })
}
