

export type AlertSeverity = "critical" | "warning" | "other"

export type AlertGroup = {
  alertname: string
  severity: AlertSeverity
  count: number
  generatorURL?: string
}
