import { loadNodeStorage } from "@/lib/features/prometheus/node-storage"
import { prometheus } from "@/lib/features/prometheus/proxy"
import { guardClusterWide } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await guardClusterWide()
  if (denied) return denied

  return Response.json(await loadNodeStorage(prometheus), { headers: { "Cache-Control": "no-store" } })
}
