import { hasSession } from "@/lib/auth/session"
import { isLlmConfigured } from "@/lib/llm"
import type { ActionFacts } from "@/lib/features/actions/types"
import { sync } from "@/lib/features/actions/queue"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_ACTIONS_PER_REQUEST = 500
const KINDS = new Set(["update-image", "upgrade-chart", "pin-digest"])
const MANAGERS = new Set(["helm", "argo", "standalone", "operator"])

function isActionFacts(value: unknown): value is ActionFacts {
  if (!value || typeof value !== "object") return false
  const f = value as Record<string, unknown>
  const manager = f.manager as Record<string, unknown> | undefined
  return (
    typeof f.kind === "string" && KINDS.has(f.kind) &&
    typeof f.repository === "string" && f.repository.length > 0 &&
    typeof f.from === "string" && typeof f.to === "string" &&
    typeof f.drift === "string" &&
    (f.sourceRepoUrl === null || typeof f.sourceRepoUrl === "string") &&
    Array.isArray(f.cves) &&
    !!manager && typeof manager.kind === "string" && MANAGERS.has(manager.kind)
  )
}

export async function POST(req: Request) {
  if (!(await hasSession())) {
    return Response.json({ error: "not authenticated" }, { status: 401 })
  }

  let body: { focus?: unknown; actions?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!Array.isArray(body.actions) || body.actions.length > MAX_ACTIONS_PER_REQUEST || !body.actions.every(isActionFacts)) {
    return Response.json({ error: "actions must be an array of action facts" }, { status: 400 })
  }

  if (!isLlmConfigured()) {
    return Response.json({ error: "LLM_BASE_URL is not set" }, { status: 503 })
  }

  return Response.json({ results: sync(body.actions, body.focus === true) }, { headers: { "Cache-Control": "no-store" } })
}
