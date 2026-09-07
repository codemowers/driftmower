import { isLlmConfigured } from "@/lib/llm"
import { callPodLiveSummaryPrompt, callPodStaticSummaryPrompt } from "@/lib/llm/prompts/pod-summary"
import type { LiveFacts, StaticFacts } from "@/lib/features/pod-summary/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isStaticFacts(facts: object): facts is StaticFacts {
  return Array.isArray((facts as StaticFacts).images)
}

function isLiveFacts(facts: object): facts is LiveFacts {
  const f = facts as LiveFacts
  return (
    typeof f.pod === "object" && f.pod !== null &&
    typeof f.net === "object" && f.net !== null &&
    typeof f.net.inbound === "object" && f.net.inbound !== null &&
    Array.isArray(f.net.listening) &&
    Array.isArray(f.net.outboundWorkloads) &&
    Array.isArray(f.net.externalInboundPeers)
  )
}

export async function POST(req: Request) {
  if (!isLlmConfigured()) {
    return Response.json({ error: "LLM_BASE_URL is not set" }, { status: 503 })
  }

  let body: { kind?: string; facts?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const { kind, facts } = body
  if (kind !== "static" && kind !== "live") {
    return Response.json({ error: "kind must be 'static' or 'live'" }, { status: 400 })
  }
  if (!facts || typeof facts !== "object") {
    return Response.json({ error: "facts is required" }, { status: 400 })
  }

  if (kind === "static" && !isStaticFacts(facts)) {
    return Response.json({ error: "facts does not match the static shape" }, { status: 400 })
  }
  if (kind === "live" && !isLiveFacts(facts)) {
    return Response.json({ error: "facts does not match the live shape" }, { status: 400 })
  }

  try {
    const stream = kind === "static" ? callPodStaticSummaryPrompt(facts as StaticFacts) : callPodLiveSummaryPrompt(facts as LiveFacts)
    return stream.toTextStreamResponse()
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e)
    console.error(`[pod-summary] ${kind} -> ${cause}`)
    return Response.json({ error: "upstream failed", cause }, { status: 502 })
  }
}
