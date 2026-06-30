import { streamQuery } from "@/lib/llm"
import {
  SYSTEM_PROMPT_LIVE,
  SYSTEM_PROMPT_STATIC,
  buildLivePrompt,
  buildStaticPrompt,
} from "@/lib/llm/pod-summary/prompts"
import type { LiveFacts, StaticFacts } from "@/lib/llm/pod-summary/types"

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

  let systemPrompt: string
  let userPrompt: string
  if (kind === "static") {
    if (!isStaticFacts(facts)) {
      return Response.json({ error: "facts does not match the static shape" }, { status: 400 })
    }
    systemPrompt = SYSTEM_PROMPT_STATIC
    userPrompt = buildStaticPrompt(facts)
  } else {
    if (!isLiveFacts(facts)) {
      return Response.json({ error: "facts does not match the live shape" }, { status: 400 })
    }
    systemPrompt = SYSTEM_PROMPT_LIVE
    userPrompt = buildLivePrompt(facts)
  }

  try {
    return streamQuery({ model: "qwen3.6-fast", systemPrompt, userPrompt }).toTextStreamResponse()
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e)
    console.error(`[pod-summary] ${kind} -> ${cause}`)
    return Response.json({ error: "upstream failed", cause }, { status: 502 })
  }
}
