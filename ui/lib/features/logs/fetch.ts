import { LOGS_CONTAINERS_URL, LOGS_URL } from "@/lib/cluster/constants"
import { TAIL_LINES } from "./constants"
import type { ContainersResponse, LogsResponse, LogSource } from "./types"

export async function fetchLogs(args: {
  ns: string
  pod: string
  uid: string
  container?: string
  sinceNs: string | null
  limit?: number
  sourceHint?: LogSource | null
  previous?: boolean
}): Promise<LogsResponse | null> {
  const params = new URLSearchParams({ ns: args.ns, pod: args.pod, uid: args.uid })
  if (args.container) params.set("container", args.container)
  if (args.sinceNs) params.set("sinceNs", args.sinceNs)
  params.set("limit", String(args.limit ?? TAIL_LINES))
  if (args.sourceHint === "kube API") params.set("source", "kube")
  if (args.previous) params.set("previous", "1")

  const res = await fetch(`${LOGS_URL}?${params}`, { cache: "no-store" })
  if (!res.ok) return null
  return (await res.json()) as LogsResponse
}

export async function fetchContainers(ns: string, pod: string): Promise<string[]> {
  const params = new URLSearchParams({ ns, pod })
  const res = await fetch(`${LOGS_CONTAINERS_URL}?${params}`, { cache: "no-store" })
  if (!res.ok) return []
  return ((await res.json()) as ContainersResponse).containers ?? []
}
