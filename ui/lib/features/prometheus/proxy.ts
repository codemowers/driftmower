import "server-only"

import { isInCluster } from "@/lib/server/k8s"
import { errorResponse } from "@/lib/server/error-response"

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
    return errorResponse(e, "prometheus", `GET ${path}`)
  }

  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 300)
    console.error(`[prometheus] GET ${path} -> ${res.status} non-JSON: ${detail}`)
    return Response.json({ error: `Prometheus returned ${res.status} with a non-JSON body`, detail }, { status: 502 })
  }

  return Response.json(await res.json(), { status: res.status })
}
