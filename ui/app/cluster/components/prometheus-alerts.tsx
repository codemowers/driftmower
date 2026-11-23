"use client"

import { ExternalLink } from "lucide-react"
import Card from "@/app/components/layout/card"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { alertGroups } from "@/lib/features/cluster/load"
import { useFiringAlerts } from "@/app/components/findings/alerts-card"
import type { AlertGroup, AlertSeverity } from "@/lib/features/prometheus/types"

const SEVERITY_STYLE: Record<AlertSeverity, { border: string; bg: string; text: string }> = {
  critical: { border: "border-l-status-major", bg: "bg-status-major-bg", text: "text-status-major-label" },
  warning: { border: "border-l-status-minor", bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  other: { border: "border-l-gray-300", bg: "bg-gray-100", text: "text-muted-foreground" },
}

// Firing alerts counted per rule, linking to Prometheus.
export default function PrometheusAlerts() {
  const prometheusUrl = useClusterState(s => s.prometheusUrl)
  const result = useFiringAlerts()
  const groups = alertGroups(result.data?.alerts ?? [])
  return (
    <Card flush title="By alert rule" meta={result.data ? `${groups.length} rules` : undefined}
      actions={prometheusUrl && <a href={`${prometheusUrl}/alerts?state=firing`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-text hover:underline">Prometheus<ExternalLink className="size-3" aria-hidden /></a>}>
      {result.data && groups.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No firing alerts.</p>}
      {result.error && <p className="px-5 py-4 text-sm text-muted-foreground">Unavailable</p>}
      <div className="divide-y divide-gray-100">
        {groups.map(group => <AlertRow key={`${group.severity}/${group.alertname}`} group={group} prometheusUrl={prometheusUrl} />)}
      </div>
    </Card>
  )
}

function AlertRow({ group, prometheusUrl }: { group: AlertGroup; prometheusUrl: string | null }) {
  const style = SEVERITY_STYLE[group.severity]
  const href = group.generatorURL ?? (prometheusUrl ? `${prometheusUrl}/alerts?state=firing&search=${encodeURIComponent(group.alertname)}` : undefined)
  const inner = (
    <div className={cn("flex items-center justify-between border-l-4 px-5 py-2.5", href && "hover:bg-brand-bg/30", style.border)}>
      <span className="truncate text-sm text-foreground">{group.alertname}</span>
      <span className={cn("rounded-md px-2 py-0.5 font-mono text-xs font-semibold", style.bg, style.text)}>×{group.count}</span>
    </div>
  )
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="block">{inner}</a> : inner
}
