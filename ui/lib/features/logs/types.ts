import type { ParsedLine } from "./parse"

export type LogSource = "loki" | "kube API"

export type LogLine = {
  tsNs: string
  tsMs: number
  pod: string
  container: string
  message: string
  key: string
  parsed: ParsedLine
}

export type LogsResponse = {
  source: LogSource | null
  // "labels" when the workload was selected by its shared Loki labels, which
  // also reaches Pods that were replaced.
  selector: "labels" | "pods" | "namespace"
  containers: string[]
  lines: LogLine[]
  warnings: string[]
}
