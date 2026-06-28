import { proxyPrometheusJson } from "@/lib/api/prometheus"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const query = new URL(req.url).searchParams.get("query")
  if (!query) return Response.json({ error: "query param required" }, { status: 400 })

  return proxyPrometheusJson("/api/v1/query", new URLSearchParams({ query }))
}
