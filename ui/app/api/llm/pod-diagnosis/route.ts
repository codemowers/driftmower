import { hasSession } from "@/lib/auth/session"
import { llmConfigError } from "@/lib/llm"
import { sync } from "@/lib/features/pod-diagnosis/diagnose"
import { MAX_PODS_PER_REQUEST } from "@/lib/features/pod-diagnosis/client"
import type { DiagnosisFacts } from "@/lib/features/pod-diagnosis/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isDiagnosisFacts(value: unknown): value is DiagnosisFacts {
  if (!value || typeof value !== "object") return false
  const f = value as Record<string, unknown>
  const podStatus = f.podStatus as Record<string, unknown> | undefined
  return (
    typeof f.key === "string" && f.key.length > 0 &&
    typeof f.podUid === "string" && f.podUid.length > 0 &&
    typeof f.namespace === "string" && f.namespace.length > 0 &&
    typeof f.name === "string" && f.name.length > 0 &&
    !!podStatus && typeof podStatus.display === "string" && Array.isArray(podStatus.containers)
  )
}

export async function POST(req: Request) {
  if (!(await hasSession())) {
    return Response.json({ error: "not authenticated" }, { status: 401 })
  }

  let body: { focus?: unknown; force?: unknown; pods?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!Array.isArray(body.pods) || body.pods.length > MAX_PODS_PER_REQUEST || !body.pods.every(isDiagnosisFacts)) {
    return Response.json({ error: "pods must be an array of diagnosis facts" }, { status: 400 })
  }

  const configError = llmConfigError()
  if (configError) {
    return Response.json({ error: configError }, { status: 503 })
  }

  return Response.json(
    { results: sync(body.pods, body.focus === true, body.force === true) },
    { headers: { "Cache-Control": "no-store" } },
  )
}
