import { proxyPrometheusJson } from "@/lib/api/prometheus"

export const dynamic = "force-dynamic"

export async function GET() {
  return proxyPrometheusJson("/api/v1/alerts")
}
