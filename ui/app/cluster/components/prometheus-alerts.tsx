"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { AlertGroup, AlertSeverity } from "@/lib/features/prometheus/types"

const MAX_VISIBLE = 5

const SEVERITY_STYLE: Record<AlertSeverity, { border: string; bg: string; text: string }> = {
  critical: {
    border: "border-l-status-major",
    bg: "bg-status-major-bg",
    text: "text-status-major-label",
  },
  warning: {
    border: "border-l-status-minor",
    bg: "bg-status-minor-bg",
    text: "text-status-minor-label",
  },
  other: {
    border: "border-l-gray-300",
    bg: "bg-gray-100",
    text: "text-muted-foreground",
  },
}

export default function PrometheusAlerts({ onCollapsedHeight }: { onCollapsedHeight?: (height: number) => void }) {
  const groups = useClusterState(s => s.prometheusAlerts)
  const prometheusUrl = useClusterState(s => s.prometheusUrl)
  const [expanded, setExpanded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (expanded) return
    const el = cardRef.current
    if (!el) return
    const update = () => onCollapsedHeight?.(el.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, groups, onCollapsedHeight])

  if (!groups || groups.length === 0) return null

  const visible = expanded ? groups : groups.slice(0, MAX_VISIBLE)
  const hidden = groups.length - MAX_VISIBLE

  return (
    <div ref={cardRef} className="rounded-xl border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Firing alerts
        </span>
        {prometheusUrl && (
          <a
            href={`${prometheusUrl}/alerts?state=firing`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-brand/40 hover:bg-brand-bg/30 hover:text-brand"
          >
            Open in Prometheus
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </header>

      <div className="divide-y divide-gray-100">
        {visible.map(group => (
          <AlertRow key={`${group.severity}/${group.alertname}`} group={group} prometheusUrl={prometheusUrl} />
        ))}
      </div>

      {(!expanded && hidden > 0) || expanded ? (
        <div className="px-5 pb-3 pt-2">
          {!expanded && hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              className="text-xs text-muted-foreground hover:text-brand hover:underline"
            >
              + {hidden} more
            </button>
          )}
          {expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-xs text-muted-foreground hover:text-brand hover:underline"
            >
              show less
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

function AlertRow({ group, prometheusUrl }: { group: AlertGroup; prometheusUrl: string | null }) {
  const style = SEVERITY_STYLE[group.severity]
  const href = group.generatorURL
    ?? (prometheusUrl ? `${prometheusUrl}/alerts?state=firing&search=${encodeURIComponent(group.alertname)}` : undefined)

  const inner = (
    <div className={cn("ml-3 flex items-center justify-between border-l-4 px-4 py-2.5 hover:bg-brand-bg/30", style.border)}>
      <span className="text-sm text-foreground">{group.alertname}</span>
      <span className={cn("rounded-md px-2 py-0.5 font-mono text-xs font-semibold", style.bg, style.text)}>
        ×{group.count}
      </span>
    </div>
  )

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        {inner}
      </a>
    )
  }

  return inner
}
