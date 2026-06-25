export type LogSource = "loki" | "kube API"

export type LogLine = {
  tsNs: string
  tsMs: number
  container: string
  message: string
  key: string
}

export type LogsResponse = {
  source: LogSource
  lines: LogLine[]
}

export type ContainersResponse = {
  containers: string[]
}
