"use client"

import { useState, type ReactNode } from "react"
import { prometheusGraphLink } from "@/lib/features/prometheus/links"
import { softWrapText } from "@/lib/utils/soft-wrap-text"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { formatBytes, formatCores } from "@/lib/utils/format-bytes"
import MetricBar from "./metric-bar"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { PodVolume, ResourceTriplet } from "@/lib/features/prometheus/query"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const MAX_VISIBLE = 5

type CardMetrics = {
  memory: ResourceTriplet
  cpu: ResourceTriplet
  volumes: PodVolume[]
  qosClass: string | null
}

type Props = {
  metrics: CardMetrics | null
  graphQueries: { memUsage: string; cpuUsage: string; volUsed?: string }
  emptyHint?: string
  podCount?: number
  qosBreakdown?: { qosClass: string; count: number }[]
}

function metricHasBar(metric: ResourceTriplet): boolean {
  return metric.usage !== null && metric.limit !== null && metric.limit > 0
}

function nameSeries(expr: string, name: string): string {
  return `label_replace(${expr}, "__name__", "${name}", "", "")`
}

export default function PrometheusResourceUsageCard({ metrics, graphQueries, emptyHint, podCount, qosBreakdown }: Props) {
  const prometheusUrl = useClusterState(s => s.prometheusUrl)

  if (!metrics) return null

  const exprs = [
    nameSeries(graphQueries.memUsage, "memory"),
    nameSeries(graphQueries.cpuUsage, "cpu"),
    ...(metrics.volumes.length > 0 && graphQueries.volUsed ? [nameSeries(graphQueries.volUsed, "volume")] : []),
  ]
  const link = prometheusUrl ? prometheusGraphLink(prometheusUrl, exprs, "1h") : null

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
          {podCount != null && (
            <span className="font-mono text-xs text-muted-foreground">
              · {podCount} {podCount === 1 ? "pod" : "pods"}
            </span>
          )}
          {showHeaderQos && metrics.qosClass && (
            <QosPill qosClass={metrics.qosClass} breakdown={qosBreakdown} />
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
          <EmptyState hint={emptyHint} />
        ) : (
          <>
            {hasComputeUsage && (
              noBars ? (
                <ComputeStats memory={metrics.memory} cpu={metrics.cpu} qosClass={qosInStrip ? metrics.qosClass : null} qosBreakdown={qosBreakdown} />
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

type QosBreakdown = { qosClass: string; count: number }[]

function withQosTooltip(trigger: ReactNode, breakdown?: QosBreakdown): ReactNode {
  if (!breakdown || breakdown.length === 0) return trigger
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          {breakdown.map(b => (
            <span key={b.qosClass} className="font-mono text-xs tabular-nums">{b.qosClass} · {b.count}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function QosPill({ qosClass, breakdown }: { qosClass: string; breakdown?: QosBreakdown }) {
  return withQosTooltip(
    <span className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-muted-foreground">{qosClass}</span>,
    breakdown,
  )
}

function statCellValue(metric: ResourceTriplet, fmt: (n: number) => string): string {
  if (metric.usage === null) return "—"
  const { request } = metric
  return request !== null && request > 0
    ? `${fmt(metric.usage)} · req ${fmt(request)}`
    : fmt(metric.usage)
}

function ComputeStats({ memory, cpu, qosClass, qosBreakdown }: { memory: ResourceTriplet; cpu: ResourceTriplet; qosClass: string | null; qosBreakdown?: QosBreakdown }) {
  const cells: { label: string; value: ReactNode }[] = [
    { label: "Memory", value: statCellValue(memory, formatBytes) },
    { label: "CPU", value: statCellValue(cpu, formatCores) },
  ]
  if (qosClass) cells.push({ label: "QoS", value: withQosTooltip(<span>{qosClass}</span>, qosBreakdown) })

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

function EmptyState({ hint }: { hint?: string }) {
  return <p className="py-1 text-center text-sm text-muted-foreground">No usage metrics yet{hint ? ` · ${hint}` : ""}</p>
}

function ComputeBar({ kind, data, className }: { kind: "memory" | "cpu"; data: ResourceTriplet; className?: string }) {
  const fmt = (n: number) => (kind === "memory" ? formatBytes(n) : formatCores(n))
  return (
    <ResourceGauge className={className} label={kind === "memory" ? "Memory" : "CPU"} fmt={fmt}
      used={data.usage} requested={data.request} ceiling={data.limit !== null && data.limit > 0 ? { value: data.limit, label: "limit" } : null} />
  )
}

type Ceiling = { value: number; label: string }

// One resource as every usage view draws it: its figures top right, as
// "0.2 used · 0.8 requested · 2.0 limit", and below them usage filled against
// the ceiling with a tick at the request and at any other ceilings.
export function ResourceGauge({ label, fmt, used, requested, ceiling, others = [], className }: {
  label: ReactNode; fmt: (n: number) => string; used: number | null; requested: number | null
  ceiling: Ceiling | null; others?: Ceiling[]; className?: string
}) {
  const figures = [
    used !== null ? `${fmt(used)} used` : "no usage data",
    ...(requested !== null && requested > 0 ? [`${fmt(requested)} requested`] : []),
    ...(ceiling ? [`${fmt(ceiling.value)} ${ceiling.label}`] : []),
    ...others.map(o => `${fmt(o.value)} ${o.label}`),
  ]
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{figures.join(" · ")}</span>
      </div>
      {used !== null && ceiling && (
        <UsageBar usage={used} limit={ceiling.value} request={requested} fmt={fmt} height="h-2.5"
          markers={others.map(o => ({ value: o.value, label: o.label }))} />
      )}
    </div>
  )
}

// Usage filled against the limit, coloured by how full it is, with a tick at
// the request; markers add further ticks, such as a namespace's quota.
export function UsageBar({ usage, limit, request, fmt, height, markers = [] }: {
  usage: number; limit: number; request: number | null; fmt: (n: number) => string; height: string
  markers?: { value: number; label: string }[]
}) {
  const hasRequest = request !== null && request > 0
  return (
    <div className="relative">
      <MetricBar value={usage} total={limit} className={height} />
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
      {markers.filter(m => m.value > 0).map(m => (
        <Tooltip key={m.label}>
          <TooltipTrigger asChild>
            <div
              className="absolute top-1/2 flex h-4 w-3 -translate-x-1/2 -translate-y-1/2 cursor-default justify-center"
              style={{ left: `clamp(1px, ${(m.value / limit) * 100}%, calc(100% - 1px))` }}
            >
              <div className="h-full w-0.5 rounded-full bg-foreground/70" />
            </div>
          </TooltipTrigger>
          <TooltipContent>{m.label} {fmt(m.value)}</TooltipContent>
        </Tooltip>
      ))}
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

  return (
    <div className="flex items-center gap-3">
      <span className="w-56 shrink-0 break-words font-mono text-xs text-foreground" title={volume.name}>
        {softWrapText(volume.name)}
      </span>
      <MetricBar value={volume.used} total={volume.capacity} className="flex-1" />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {formatBytes(volume.used)} / {formatBytes(volume.capacity)}
      </span>
    </div>
  )
}
