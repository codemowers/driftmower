import { POD_DIAGNOSIS_URL } from "@/lib/cluster/constants"
import { readApiError } from "@/lib/utils/read-api-error"
import type { DiagnoseRequest,DiagnoseResponse,DiagnosisState } from "./types"

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
