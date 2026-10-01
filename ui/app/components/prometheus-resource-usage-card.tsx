"use client"

import { useState, type ReactNode } from "react"
import { softWrapText } from "@/lib/utils/soft-wrap-text"
import { ChevronRight, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { formatBytes, formatCores } from "@/lib/utils/format-bytes"
import { usageBarColor } from "@/lib/utils/usage-color"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { PodVolume, ResourceTriplet } from "@/lib/features/prometheus/query"
import type { PerPodMetrics } from "@/lib/features/prometheus/workload-metrics"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import PrefetchLink from "@/app/components/prefetch-link"

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
  perPod?: PerPodMetrics[]
  qosBreakdown?: { qosClass: string; count: number }[]
  podHref?: (podName: string) => string | null
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

function nameSeries(expr: string, name: string): string {
  return `label_replace(${expr}, "__name__", "${name}", "", "")`
}

export default function PrometheusResourceUsageCard({ metrics, graphQueries, emptyHint, podCount, perPod, qosBreakdown, podHref }: Props) {
  const prometheusUrl = useClusterState(s => s.prometheusUrl)

  if (!metrics) return null

  const exprs = [
    nameSeries(graphQueries.memUsage, "memory"),
    nameSeries(graphQueries.cpuUsage, "cpu"),
    ...(metrics.volumes.length > 0 && graphQueries.volUsed ? [nameSeries(graphQueries.volUsed, "volume")] : []),
  ]
  const link = prometheusUrl ? buildPrometheusGraphLink(prometheusUrl, exprs) : null

  const hasComputeUsage = metrics.memory.usage !== null || metrics.cpu.usage !== null
  const noBars = !metricHasBar(metrics.memory) && !metricHasBar(metrics.cpu)
  const qosInStrip = noBars && hasComputeUsage
  const showHeaderQos = metrics.qosClass !== null && !qosInStrip
  const showBreakdown = !!perPod && perPod.length > 1

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

            {showBreakdown && <PerPodBreakdown pods={perPod} podHref={podHref} />}
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
        <UsageBar usage={usage} limit={limit} request={request} fmt={fmt} height="h-2.5" />
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

function UsageBar({ usage, limit, request, fmt, height }: { usage: number; limit: number; request: number | null; fmt: (n: number) => string; height: string }) {
  const hasRequest = request !== null && request > 0
  return (
    <div className="relative">
      <div className={cn("w-full overflow-hidden rounded-full bg-gray-100", height)}>
        <div
          className={cn("h-full rounded-full", usageBarColor(usage / limit))}
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
  )
}

const PER_POD_GRID = "grid grid-cols-[auto_auto_auto_auto] justify-start"
const MAX_VISIBLE_PODS = 10

function PerPodBreakdown({ pods, podHref }: { pods: PerPodMetrics[]; podHref?: (podName: string) => string | null }) {
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const visible = showAll ? pods : pods.slice(0, MAX_VISIBLE_PODS)
  const hidden = pods.length - MAX_VISIBLE_PODS

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        Per-pod breakdown
      </button>

      {expanded && (
        <div className="mt-3">
          <div className={PER_POD_GRID}>
            <HeaderCell>Pod</HeaderCell>
            <HeaderCell>Memory</HeaderCell>
            <HeaderCell>CPU</HeaderCell>
            <HeaderCell>QoS</HeaderCell>
            {visible.map((pod, i) => (
              <PodRow key={pod.podName} pod={pod} href={podHref?.(pod.podName) ?? null} divider={i > 0} />
            ))}
          </div>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              className="mt-2.5 text-xs text-muted-foreground hover:text-brand hover:underline"
            >
              {showAll ? "show less" : `+ ${hidden} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function HeaderCell({ children }: { children: string }) {
  return (
    <div className="border-b border-gray-100 pb-2 pr-8">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</span>
    </div>
  )
}

function PodRow({ pod, href, divider }: { pod: PerPodMetrics; href: string | null; divider: boolean }) {
  const cell = cn("flex items-center py-2 pr-8 transition-colors", divider && "border-t border-gray-100", href && "group-hover:bg-brand-bg/30")
  const inner = (
    <>
      <div className={cn(cell, "min-w-0")}>
        <span className="truncate font-mono text-xs text-foreground" title={pod.podName}>{pod.podName}</span>
      </div>
      <PodMetricCell kind="memory" data={pod.memory} cellClass={cell} />
      <PodMetricCell kind="cpu" data={pod.cpu} cellClass={cell} />
      <div className={cell}>
        <span className="font-mono text-xs text-muted-foreground">{pod.qosClass ?? "—"}</span>
      </div>
    </>
  )

  if (href) {
    return <PrefetchLink href={href} className="group contents">{inner}</PrefetchLink>
  }
  return inner
}

function PodMetricCell({ kind, data, cellClass }: { kind: "memory" | "cpu"; data: ResourceTriplet; cellClass: string }) {
  const { usage, limit } = data
  const fmt = (n: number) => (kind === "memory" ? formatBytes(n) : formatCores(n))
  const minWidth = kind === "memory" ? "min-w-[7.5rem]" : "min-w-[6rem]"

  if (usage !== null && limit !== null && limit > 0) {
    return (
      <div className={cn(cellClass, minWidth, "gap-2.5")}>
        <div className="w-40">
          <UsageBar usage={usage} limit={limit} request={data.request} fmt={fmt} height="h-2" />
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmt(usage)} / {fmt(limit)}</span>
      </div>
    )
  }

  return (
    <div className={cn(cellClass, minWidth)}>
      <span className="font-mono text-xs tabular-nums text-foreground">{statCellValue(data, fmt)}</span>
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
        {softWrapText(volume.name)}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className={cn("h-full rounded-full", usageBarColor(pct))} style={{ width: `${Math.min(pct * 100, 100)}%` }} />
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {formatBytes(volume.used)} / {formatBytes(volume.capacity)}
      </span>
    </div>
  )
}
