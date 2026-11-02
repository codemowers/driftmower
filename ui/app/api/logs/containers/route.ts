import { listContainers } from "@/lib/features/logs/pod"
import { guardRead } from "@/lib/server/sandbox-scope-filter"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { containers: string[]; expiresAt: number }>()

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const ns = sp.get("ns")
  const pod = sp.get("pod")
  if (!ns || !pod) {
    return Response.json({ error: "ns, pod required" }, { status: 400 })
  }

  const denied = await guardRead(ns)
  if (denied) return denied

  const key = `${ns}/${pod}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) {
    return Response.json({ containers: hit.containers }, { headers: { "Cache-Control": "no-store" } })
  }

  try {
    const containers = await listContainers(ns, pod)
    cache.set(key, { containers, expiresAt: now + CACHE_TTL_MS })
    return Response.json({ containers }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return errorResponse(e, "logs", `containers ${ns}/${pod}`)
  }
}
