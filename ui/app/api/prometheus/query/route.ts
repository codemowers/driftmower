import { isInCluster } from "@/lib/api/k8s"

export const dynamic = "force-dynamic"

const INTERNAL_URL = "http://prometheus-operated.monitoring:9090"

function resolveUrl(): string | null {
  if (isInCluster()) return INTERNAL_URL
  const override = process.env.PROMETHEUS_URL
  if (override) return override
  return null
}

export async function GET(req: Request) {
  const url = resolveUrl()
  if (!url) return Response.json({ error: "Prometheus not reachable" }, { status: 503 })

  const query = new URL(req.url).searchParams.get("query")
  if (!query) return Response.json({ error: "query param required" }, { status: 400 })

  let res: Response
  try {
    const target = new URL(`${url}/api/v1/query`)
    target.searchParams.set("query", query)
    res = await fetch(target.toString(), { cache: "no-store" })
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e)
    return Response.json({ error: "upstream unreachable", cause }, { status: 502 })
  }

  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return Response.json({ error: "upstream returned non-JSON", status: res.status }, { status: 502 })
  }

  return Response.json(await res.json(), { status: res.status })
}
