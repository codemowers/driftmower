"use client"

import { Fragment, useState } from "react"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { formatBytes, formatCores } from "@/lib/utils/format-bytes"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { podMetricQueries, type PodVolume, type ResourceTriplet } from "@/lib/cluster/prometheus/pod-metrics"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePodMetrics } from "../hooks/use-pod-metrics"

const MAX_VISIBLE = 5

function barColor(pct: number): string {
  if (pct < 0.7) return "bg-status-ok"
  if (pct < 0.85) return "bg-status-minor"
  return "bg-status-major"
}

function metricHasBar(metric: ResourceTriplet): boolean {
  return metric.usage !== null && metric.limit !== null && metric.limit > 0
}

function buildPrometheusGraphLink(baseUrl: string, exprs: string[]): string {
  const params = new URLSearchParams()
  exprs.forEach((expr, i) => {
    params.set(`g${i}.expr`, expr)
    params.set(`g${i}.tab`, "0")
  })
  return `${baseUrl}/graph?${params.toString()}`
}

export default function ResourceUsageCard({ namespace, name, phase }: { namespace: string; name: string; phase?: string }) {
  const metrics = usePodMetrics(namespace, name)
  const prometheusUrl = useClusterState(s => s.prometheusAlerts?.prometheusUrl ?? null)

  if (!metrics) return null

  const q = podMetricQueries(namespace, name)
  const exprs = [q.memUsage, q.cpuUsage, ...(metrics.volumes.length > 0 ? [q.volUsed] : [])]
  const link = prometheusUrl ? buildPrometheusGraphLink(prometheusUrl, exprs) : null

  const hasComputeUsage = metrics.memory.usage !== null || metrics.cpu.usage !== null
  const noBars = !metricHasBar(metrics.memory) && !metricHasBar(metrics.cpu)
  const qosInStrip = noBars && hasComputeUsage
  const showHeaderQos = metrics.qosClass !== null && !qosInStrip

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Resource usage
          </span>
          {showHeaderQos && (
            <span className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {metrics.qosClass}
            </span>
          )}
        </div>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-brand/40 hover:bg-brand-bg/30 hover:text-brand"
          >
            Open in Prometheus
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </header>

      <div className="px-5 py-4">
        {!hasComputeUsage && metrics.volumes.length === 0 ? (
          <EmptyState phase={phase} />
        ) : (
          <>
            {hasComputeUsage && (
              noBars ? (
                <ComputeStats memory={metrics.memory} cpu={metrics.cpu} qosClass={metrics.qosClass} />
              ) : (
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8">
                  <ComputeBar kind="memory" data={metrics.memory} className="md:flex-1 md:min-w-0" />
                  <ComputeBar kind="cpu" data={metrics.cpu} className="md:flex-1 md:min-w-0" />
                </div>
              )
            )}

            {metrics.volumes.length > 0 && (
              <div className={cn(hasComputeUsage && "mt-4")}>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Volumes</p>
                <VolumeList volumes={metrics.volumes} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ComputeStats({ memory, cpu, qosClass }: { memory: ResourceTriplet; cpu: ResourceTriplet; qosClass: string | null }) {
  const cells = [
    { label: "Memory", value: memory.usage !== null ? formatBytes(memory.usage) : "—" },
    { label: "CPU", value: cpu.usage !== null ? formatCores(cpu.usage) : "—" },
  ]
  if (qosClass) cells.push({ label: "QoS", value: qosClass })

  return (
    <div className="flex divide-x divide-gray-200">
      {cells.map((cell, i) => (
        <div
          key={cell.label}
          className={cn("flex flex-1 flex-col gap-1", i === 0 ? "pr-6" : i === cells.length - 1 ? "pl-6" : "px-6")}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{cell.label}</p>
          <p className="font-mono text-sm text-foreground">{cell.value}</p>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ phase }: { phase?: string }) {
  const suffix = phase && phase !== "Running" ? ` · pod is ${phase}` : ""
  return <p className="py-1 text-center text-sm text-muted-foreground">No usage metrics yet{suffix}</p>
}

function ComputeBar({ kind, data, className }: { kind: "memory" | "cpu"; data: ResourceTriplet; className?: string }) {
  const { usage, limit, request } = data
  const hasUsage = usage !== null
  const hasLimit = limit !== null && limit > 0
  const hasRequest = request !== null && request > 0

  const title = kind === "memory" ? "Memory" : "CPU"
  const fmt = (n: number) => (kind === "memory" ? formatBytes(n) : formatCores(n))

  if (hasUsage && hasLimit) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmt(usage)} / {fmt(limit)}</span>
        </div>
        <div className="relative">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={cn("h-full rounded-full", barColor(usage / limit))}
              style={{ width: `${Math.min((usage / limit) * 100, 100)}%` }}
            />
          </div>
          {hasRequest && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="absolute top-1/2 flex h-4 w-3 -translate-x-1/2 -translate-y-1/2 cursor-default justify-center"
                  style={{ left: `clamp(1px, ${(request / limit) * 100}%, calc(100% - 1px))` }}
                >
                  <div className="h-full w-0.5 rounded-full bg-foreground/40" />
                </div>
              </TooltipTrigger>
              <TooltipContent>Request {fmt(request)} · guaranteed reservation</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    )
  }

  const value = hasUsage
    ? `used ${fmt(usage)}${hasRequest ? ` · req ${fmt(request)}` : ""}`
    : "—"

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
      <span className="font-mono text-xs tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function VolumeList({ volumes }: { volumes: PodVolume[] }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? volumes : volumes.slice(0, MAX_VISIBLE)
  const hidden = volumes.length - MAX_VISIBLE

  return (
    <div className="flex flex-col gap-2.5">
      {visible.map(volume => <VolumeRow key={volume.name} volume={volume} />)}
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="self-start text-xs text-muted-foreground hover:text-brand hover:underline"
        >
          {expanded ? "show less" : `+ ${hidden} more`}
        </button>
      )}
    </div>
  )
}

function VolumeRow({ volume }: { volume: PodVolume }) {
  const pct = volume.capacity > 0 ? volume.used / volume.capacity : 0

  return (
    <div className="flex items-center gap-3">
      <span className="w-56 shrink-0 break-words font-mono text-xs text-foreground" title={volume.name}>
        {withBreaks(volume.name)}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className={cn("h-full rounded-full", barColor(pct))} style={{ width: `${Math.min(pct * 100, 100)}%` }} />
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {formatBytes(volume.used)} / {formatBytes(volume.capacity)}
      </span>
    </div>
  )
}

function withBreaks(text: string) {
  const segments = text.split(/(?<=[-.])/)
  return segments.map((segment, i) => (
    <Fragment key={i}>
      {segment}
      {i < segments.length - 1 && <wbr />}
    </Fragment>
  ))
}
