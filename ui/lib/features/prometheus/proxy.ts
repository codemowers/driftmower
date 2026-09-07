import "server-only"

import { isInCluster } from "@/lib/server/k8s"

const INTERNAL_URL = "http://prometheus-operated.monitoring:9090"

export function resolvePrometheusUrl(): string | null {
  if (isInCluster()) return INTERNAL_URL
  return process.env.PROMETHEUS_URL || null
}

export async function proxyPrometheusJson(
  path: string,
  searchParams?: URLSearchParams,
): Promise<Response> {
  const base = resolvePrometheusUrl()
  if (!base) return Response.json({ error: "Prometheus not reachable" }, { status: 503 })

  const target = new URL(`${base}${path}`)
  searchParams?.forEach((value, key) => target.searchParams.set(key, value))

  let res: Response
  try {
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
