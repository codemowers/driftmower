import { proxyPrometheusJson } from "@/lib/features/prometheus/proxy"

export const dynamic = "force-dynamic"

export async function GET() {
  return proxyPrometheusJson("/api/v1/alerts")
}
