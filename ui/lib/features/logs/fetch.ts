import { callTool } from "@/browser/connection"
import { nsToRFC3339 } from "./line"
import { parseLogLine } from "./parse"
import type { LogsResponse } from "./types"

type WorkloadLogs = {
  source: "loki" | "kubernetes" | "none"
  selector: "labels" | "pods" | "namespace"
  containers: string[]
  entries: { tsNs: string; pod: string; container: string; line: string }[]
  warnings: string[]
}

// One workload's logs, one of its Pods', or without a workload the whole
// namespace's, merged oldest first by MCP.
export async function fetchLogs(args: {
  namespace: string
  workloadUid?: string
  pod?: string
  container?: string
  sinceNs: string | null
  limit: number
}): Promise<LogsResponse> {
  const r = await callTool<WorkloadLogs>("query_workload_logs", {
    namespace: args.namespace,
    ...(args.workloadUid ? { uid: args.workloadUid } : {}),
    ...(args.pod ? { pod: args.pod } : {}),
    ...(args.container ? { container: args.container } : {}),
    ...(args.sinceNs ? { start: nsToRFC3339(args.sinceNs) } : {}),
    limit: args.limit,
  })
  return {
    source: r.source === "loki" ? "loki" : r.source === "kubernetes" ? "kube API" : null,
    selector: r.selector,
    containers: r.containers,
    warnings: r.warnings,
    lines: r.entries.map(e => ({
      tsNs: e.tsNs,
      tsMs: Number(BigInt(e.tsNs) / BigInt(1_000_000)),
      pod: e.pod,
      container: e.container,
      message: e.line,
      key: `${e.tsNs}|${e.pod}|${e.container}|${e.line}`,
      parsed: parseLogLine(e.line),
    })),
  }
}
