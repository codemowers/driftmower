import { llmConfigError } from "@/lib/llm"
import { podFacts, prewarmFacts, sync } from "@/lib/features/pod-diagnosis/diagnose"
import { readScope } from "@/lib/server/sandbox-scope-filter"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store" }

export async function POST(req: Request) {
  let body: { podUid?: unknown; force?: unknown; prewarm?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (body.prewarm !== true && (typeof body.podUid !== "string" || body.podUid.length === 0)) {
    return Response.json({ error: "podUid or prewarm is required" }, { status: 400 })
  }

  const allows = await readScope()
  if (allows instanceof Response) return allows

  const configError = llmConfigError()
  if (configError) {
    return Response.json({ error: configError }, { status: 503 })
  }

  try {
    if (body.prewarm === true) {
      return Response.json({ key: null, results: sync(await prewarmFacts(allows), false, false) }, { headers: NO_STORE })
    }

    const facts = await podFacts(body.podUid as string, allows)
    if (facts instanceof Response) return facts
    if (!facts) return Response.json({ key: null, results: {} }, { headers: NO_STORE })

    return Response.json({ key: facts.key, results: sync([facts], true, body.force === true) }, { headers: NO_STORE })
  } catch (e) {
    return errorResponse(e, "pod-diagnosis", body.prewarm === true ? "prewarm" : String(body.podUid))
  }
}
