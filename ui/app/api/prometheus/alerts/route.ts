import { proxyPrometheusJson } from "@/lib/features/prometheus/proxy"
import { guardClusterWide } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await guardClusterWide()
  if (denied) return denied

  return proxyPrometheusJson("/api/v1/alerts")
}
