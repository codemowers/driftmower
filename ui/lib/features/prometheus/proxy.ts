import "server-only"

import { isInCluster } from "@/lib/server/k8s"
import { causeOf, errorResponse } from "@/lib/server/error-response"
import type { PromQuery, VectorRow } from "./query"

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

const KUBE_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/

export function isKubeName(value: string): boolean {
  return KUBE_NAME.test(value)
}

async function query(promql: string): Promise<VectorRow[] | null> {
  const base = resolvePrometheusUrl()
  if (!base) return null

  const url = new URL(`${base}/api/v1/query`)
  url.searchParams.set("query", promql)

  try {
    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) {
      console.error(`[prometheus] query -> ${res.status} ${res.statusText}`)
      return null
    }
    const json = (await res.json()) as { data?: { result?: VectorRow[] } }
    return json.data?.result ?? []
  } catch (e) {
    console.error(`[prometheus] query -> unreachable (cause: ${causeOf(e) ?? String(e)})`)
    return null
  }
}

export const prometheus: PromQuery = {
  async scalar(promql) {
    const raw = (await query(promql))?.[0]?.value?.[1]
    if (raw === undefined) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  },
  async vector(promql) {
    return (await query(promql)) ?? []
  },
}
