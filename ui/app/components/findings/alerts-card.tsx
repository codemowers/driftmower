"use client"

import { useCallback, useState } from "react"
import Card from "@/app/components/layout/card"
import PrefetchLink from "@/app/components/prefetch-link"
import ShowMore from "./show-more"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { fetchMcpJSON, toolNames } from "@/browser/connection"
import { alertActions, alertHref, type AlertScope, type FiringAlert } from "@/lib/features/actions/alerts"
import { cn } from "@/lib/utils/cn"

const COLORS: Record<string, string> = { critical: "bg-status-major-bg text-status-major-label", warning: "bg-status-minor-bg text-status-minor-label", info: "bg-brand-bg text-brand-label" }

// Unsilenced firing alerts grouped by affected resource, highest priority
// first. Renders across the cluster or within a namespace, workload or Pod.
// Firing alerts, polled every 30 seconds while mounted.
export function useFiringAlerts() {
  const cluster = useClusterState(s => s.clusterName)
  const load = useCallback(async (signal: AbortSignal) => {
    if (!(await toolNames()).has("list_alerts")) throw new Error("Alertmanager is not configured")
    return fetchMcpJSON<{ alerts: FiringAlert[] }>("/api/observability/alerts", { signal })
  }, [])
  return useQuery({ key: cluster ? JSON.stringify([cluster, "alerts"]) : null, load, interval: 30_000, keepDataOnError: false })
}

export default function AlertsCard({ title = "Firing alerts", scope, limit, hideWhenEmpty = false }: { title?: string; scope?: AlertScope; limit?: number; hideWhenEmpty?: boolean }) {
  const { namespaces } = useSandboxScope()
  const { linkTo } = useContextHref()
  const [expanded, setExpanded] = useState(false)
  const result = useFiringAlerts()
  const actions = alertActions(result.data?.alerts ?? [], namespaces, scope)
  if (hideWhenEmpty && (!result.data || actions.length === 0)) return null
  const shown = limit && !expanded ? actions.slice(0, limit) : actions
  return (
    <Card flush title={title} meta={result.data ? `${actions.length} affected ${actions.length === 1 ? "resource" : "resources"}` : undefined}>
      {result.loading && <p className="px-5 py-4 text-sm text-muted-foreground">Loading firing alerts…</p>}
      {result.error && <p role="alert" className="px-5 py-4 text-sm text-status-major-label">Alerts unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
      {result.data && !actions.length && <p className="px-5 py-4 text-sm text-muted-foreground">No unsilenced firing alerts in this scope. This does not establish complete security coverage.</p>}
      <ul className="divide-y divide-gray-100">{shown.map(action => {
        const first = action.alerts[0]
        return <li key={action.key} className="flex items-start gap-3 px-5 py-3">
          <span className={cn("shrink-0 rounded px-2 py-0.5 text-xs font-semibold", COLORS[first.severity] ?? "bg-muted text-muted-foreground")}>{first.severity || "other"}</span>
          <div className="min-w-0 flex-1">
            <PrefetchLink href={linkTo(alertHref(first))} className="text-sm font-medium hover:underline">{first.summary || first.alertname}</PrefetchLink>
            <p className="mt-0.5 text-xs text-muted-foreground">{first.namespace ?? "Cluster-wide"} · {action.alerts.length} firing {action.alerts.length === 1 ? "signal" : "signals"}</p>
            <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted-foreground">Evidence and next steps</summary>{action.alerts.map(alert => <div key={alert.fingerprint} className="mt-3"><p className="font-medium">{alert.alertname}</p><p className="mt-1 whitespace-pre-line text-muted-foreground">{alert.description || alert.summary || "No description supplied by the alert rule."}</p></div>)}</details>
          </div>
        </li>
      })}</ul>
      {limit && <ShowMore total={actions.length} limit={limit} expanded={expanded} onToggle={() => setExpanded(e => !e)} noun="alerts" />}
    </Card>
  )
}
