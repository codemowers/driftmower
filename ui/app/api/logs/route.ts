import { getPodLogs } from "@/lib/features/logs/pod"
import { guardNamespace } from "@/lib/server/sandbox-scope-filter"
import { TAIL_LINES } from "@/lib/features/logs/constants"
import type { LogSource } from "@/lib/features/logs/types"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const ns = sp.get("ns")
  const pod = sp.get("pod")
  const uid = sp.get("uid")
  if (!ns || !pod || !uid) {
    return Response.json({ error: "ns, pod, uid required" }, { status: 400 })
  }

  const denied = await guardNamespace(ns)
  if (denied) return denied

  const container = sp.get("container") ?? undefined
  const sinceNs = sp.get("sinceNs")
  const limitParam = sp.get("limit")
  const limit = limitParam ? Number(limitParam) : TAIL_LINES
  const source: LogSource | null = sp.get("source") === "kube" ? "kube API" : null
  const previous = sp.get("previous") === "1"

  try {
    const body = await getPodLogs({ ns, pod, uid, container, sinceNs, limit, source, previous })
    return Response.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 })
  }
}
