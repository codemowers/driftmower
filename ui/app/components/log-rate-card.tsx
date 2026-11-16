"use client"

import { useCallback } from "react"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { fetchMcpJSON, toolNames } from "@/browser/connection"

type LogRate = { linesPerSecond: number | null; warnings: string[] }

export default function LogRate({ namespace, pod, podNames }: { namespace: string; pod?: string; podNames?: string[] }) {
  const cluster = useClusterState(s => s.clusterName)
  const selected = JSON.stringify(podNames ? [...podNames].sort() : null)
  const load = useCallback(async (signal: AbortSignal) => {
    if (!(await toolNames()).has("get_log_rate")) return null
    const names = JSON.parse(selected) as string[] | null
    if (names?.length === 0) return { linesPerSecond: null, warnings: [] }
    const query = new URLSearchParams({ namespace, ...(pod ? { pod } : {}) })
    for (const name of names ?? []) query.append("pods", name)
    return fetchMcpJSON<LogRate>(`/api/observability/log-rate?${query}`, { signal })
  }, [namespace, pod, selected])
  const result = useQuery({ key: JSON.stringify([cluster, namespace, pod, selected, "log-rate"]), load, interval: 30_000 })
  const value = result.data?.linesPerSecond
  const label = result.loading ? "Loading rate…" : result.error ? "Rate unavailable" : value == null ? "Rate unavailable" : `${value >= 100 ? Math.round(value) : value.toFixed(value >= 1 ? 1 : 2)} lines/s`
  return <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" title={result.error || result.data?.warnings.join("\n") || "Stored log entries, averaged over 5 minutes"}>{label}</span>
}
