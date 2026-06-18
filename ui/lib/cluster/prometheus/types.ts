export type PrometheusAlert = {
  labels: Record<string, string>
  annotations: Record<string, string>
  state: string
  activeAt: string
  value: string
  generatorURL?: string
}

export type AlertSeverity = "critical" | "warning" | "other"

export type AlertGroup = {
  alertname: string
  severity: AlertSeverity
  count: number
  generatorURL?: string
}
