import { getPodLogs } from "@/lib/cluster/logs/pod"
import { TAIL_LINES } from "@/lib/cluster/logs/constants"
import type { LogSource } from "@/lib/cluster/logs/types"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const ns = sp.get("ns")
  const pod = sp.get("pod")
  const uid = sp.get("uid")
  if (!ns || !pod || !uid) {
    return Response.json({ error: "ns, pod, uid required" }, { status: 400 })
  }

  const container = sp.get("container") ?? undefined
  const sinceNs = sp.get("sinceNs")
  const limitParam = sp.get("limit")
  const limit = limitParam ? Number(limitParam) : TAIL_LINES
  const source: LogSource | null = sp.get("source") === "kube" ? "kube API" : null

  try {
    const body = await getPodLogs({ ns, pod, uid, container, sinceNs, limit, source })
    return Response.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 })
  }
}
