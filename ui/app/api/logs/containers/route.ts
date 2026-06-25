import { listContainers } from "@/lib/cluster/logs/pod"

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
    return Response.json({ error: (e as Error).message, containers: [] }, { status: 502 })
  }
}
