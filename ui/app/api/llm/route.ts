import { MODELS, query, streamQuery, type ModelKey } from "@/lib/llm"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(req: Request) {
  let body: { model?: string; systemPrompt?: string; userPrompt?: string; stream?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const { model, systemPrompt, userPrompt, stream } = body
  if (!model || !(model in MODELS)) {
    return Response.json(
      { error: "unknown model", models: Object.keys(MODELS) },
      { status: 400 },
    )
  }
  if (!userPrompt || typeof userPrompt !== "string") {
    return Response.json({ error: "userPrompt is required" }, { status: 400 })
  }

  const args = { model: model as ModelKey, systemPrompt, userPrompt }

  try {
    if (stream) {
      return streamQuery(args).toTextStreamResponse()
    }
    const text = await query(args)
    return Response.json({ text }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e)
    console.error(`[llm] ${model} -> ${cause}`)
    return Response.json({ error: "upstream failed", cause }, { status: 502 })
  }
}
