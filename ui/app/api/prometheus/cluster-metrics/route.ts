import { loadClusterMetrics } from "@/lib/features/prometheus/metrics"
import { prometheus } from "@/lib/features/prometheus/proxy"
import { guardClusterWide } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await guardClusterWide()
  if (denied) return denied

  return Response.json(await loadClusterMetrics(prometheus), { headers: { "Cache-Control": "no-store" } })
}
