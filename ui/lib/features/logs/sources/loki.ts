import "server-only"

import { isInCluster } from "@/lib/server/k8s"
import type { LogLine } from "../types"
import { compareNs, makeKey, nowNs, nsToMs } from "../line"

const LOKI_INTERNAL_URL = "http://loki.monitoring:3100"
const LOOKBACK_NS = BigInt(24 * 60 * 60) * BigInt(1_000_000_000)
const INCREMENTAL_LIMIT = 5000

export function resolveLokiUrl(): string | null {
  if (isInCluster()) return LOKI_INTERNAL_URL
  const override = process.env.LOKI_URL
  if (override) return override
  return null
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function buildLogQL(uid: string, container?: string): string {
  const selector = container
    ? `uid="${escapeLabel(uid)}", container="${escapeLabel(container)}"`
    : `uid="${escapeLabel(uid)}"`
  return `{${selector}}`
}

type LokiResult = {
  data?: {
    result?: { stream?: Record<string, string>; values?: [string, string][] }[]
  }
}

export async function fetchLokiLines(args: {
  url: string
  uid: string
  container?: string
  sinceNs: string | null
  limit: number
}): Promise<LogLine[] | null> {
  const { url, uid, container, sinceNs, limit } = args
  const target = new URL(`${url}/loki/api/v1/query_range`)
  target.searchParams.set("query", buildLogQL(uid, container))
  target.searchParams.set("end", nowNs().toString())
  if (sinceNs === null) {
    target.searchParams.set("limit", String(limit))
    target.searchParams.set("start", (nowNs() - LOOKBACK_NS).toString())
    target.searchParams.set("direction", "backward")
  } else {
    target.searchParams.set("limit", String(INCREMENTAL_LIMIT))
    target.searchParams.set("start", (BigInt(sinceNs) + BigInt(1)).toString())
    target.searchParams.set("direction", "forward")
  }

  let res: Response
  try {
    res = await fetch(target.toString(), { cache: "no-store" })
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code
    console.warn(`[logs] loki ${url} unreachable, falling back to the kube API: ${(e as Error).message}${cause ? ` (${cause})` : ""}`)
    return null
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) {
    console.warn(`[logs] loki ${url} -> ${res.status} ${res.headers.get("content-type") ?? ""}, falling back to the kube API`)
    return null
  }

  const json = (await res.json()) as LokiResult
  const lines: LogLine[] = []
  for (const stream of json.data?.result ?? []) {
    const streamContainer = stream.stream?.container ?? "—"
    for (const [tsNs, message] of stream.values ?? []) {
      lines.push({ tsNs, tsMs: nsToMs(tsNs), container: streamContainer, message, key: makeKey(tsNs, streamContainer, message) })
    }
  }
  lines.sort((a, b) => compareNs(a.tsNs, b.tsNs))
  return lines
}
