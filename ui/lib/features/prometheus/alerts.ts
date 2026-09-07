import type { AlertGroup, AlertSeverity, PrometheusAlert } from "./types"

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 2,
  warning: 1,
  other: 0,
}

function resolveSeverity(severity: string): AlertSeverity {
  if (severity === "critical") return "critical"
  if (severity === "warning") return "warning"
  return "other"
}

export type AlertsResult = {
  groups: AlertGroup[]
  prometheusUrl: string
}

export async function fetchClusterAlerts(): Promise<AlertsResult> {
  const [alertsRes, configRes] = await Promise.all([
    fetch("/api/prometheus/alerts", { cache: "no-store" }),
    fetch("/api/prometheus/config", { cache: "no-store" }),
  ])

  const prometheusUrl = configRes.ok
    ? ((await configRes.json()) as { url?: string }).url ?? ""
    : ""

  if (!alertsRes.ok) return { groups: [], prometheusUrl }

  const json = await alertsRes.json() as { data?: { alerts?: PrometheusAlert[] } }
  const alerts = json.data?.alerts ?? []

  const firing = alerts.filter(a => a.state === "firing")

  const map = new Map<string, { severity: AlertSeverity; count: number; generatorURL?: string }>()
  for (const alert of firing) {
    const name = alert.labels.alertname ?? "unknown"
    const sev = resolveSeverity(alert.labels.severity ?? "")
    const existing = map.get(name)
    if (!existing) {
      map.set(name, { severity: sev, count: 1, generatorURL: alert.generatorURL })
    } else {
      map.set(name, {
        severity: SEVERITY_ORDER[sev] > SEVERITY_ORDER[existing.severity] ? sev : existing.severity,
        count: existing.count + 1,
        generatorURL: existing.generatorURL ?? alert.generatorURL,
      })
    }
  }

  const groups = Array.from(map.entries())
    .map(([alertname, { severity, count, generatorURL }]) => ({ alertname, severity, count, generatorURL }))
    .sort((a, b) => {
      const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]
      return sevDiff !== 0 ? sevDiff : b.count - a.count
    })

  return { groups, prometheusUrl }
}
