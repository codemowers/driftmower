"use client"

import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ClusterIO, IORates } from "@/lib/features/prometheus/metrics"
import { formatBytes } from "@/lib/utils/format-bytes"
import MetricBar from "@/app/components/metric-bar"
import GraphLink from "@/app/components/graph-link"

const rate = (value: number | null | undefined) => value == null ? "Unavailable" : `${formatBytes(value)}/s`
type Channel = { key: keyof IORates; label: string; color: string }
const network: Channel[] = [{ key: "networkRx", label: "Receive", color: "bg-chart-1" }, { key: "networkTx", label: "Transmit", color: "bg-chart-2" }]
const disk: Channel[] = [{ key: "diskRead", label: "Read", color: "bg-chart-1" }, { key: "diskWrite", label: "Write", color: "bg-chart-2" }]

function Rates({ title, channels, io, graph, hint }: { title: string; channels: Channel[]; io: ClusterIO | null | undefined; graph?: string[]; hint: string }) {
  const ceiling = Math.max(1, ...(io?.nodes ?? []).flatMap(n => channels.map(c => n[c.key] ?? 0)))
  return <section className="rounded-xl border border-gray-200 bg-white">
    <header className="border-b border-gray-200 px-5 py-3"><GraphLink exprs={graph}><span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span></GraphLink></header>
    <div className="flex flex-col gap-5 px-5 py-4">
      <div className="flex flex-wrap gap-x-8 gap-y-2">{channels.map(c => <div key={c.key}><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-2 rounded-full ${c.color}`} />{c.label}</div><p className="mt-1 font-mono text-lg">{rate(io?.[c.key])}</p></div>)}</div>
      {io?.nodes.map(n => <div key={n.node} className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">{n.node}</span>
        {channels.map(c => <div key={c.key} className="grid grid-cols-[4rem_1fr_7rem] items-center gap-2 text-xs">
          <span className="text-muted-foreground">{c.label}</span>
          <MetricBar value={n[c.key]??0} total={ceiling} color={c.color} label={`${n.node} ${c.label}: ${rate(n[c.key])}`} />
          <span className="text-right font-mono">{rate(n[c.key])}</span>
        </div>)}
      </div>)}
      <p className="text-xs text-muted-foreground">Five-minute average · {hint}</p>
    </div>
  </section>
}

export default function ClusterIOCards() {
  const metrics = useClusterState(s => s.clusterMetrics)
  return <div className="flex flex-col gap-3">
    <div className="grid gap-4 lg:grid-cols-2">
      <Rates title="Network I/O" channels={network} io={metrics?.io} graph={metrics?.graphs?.network} hint="Host interfaces; common virtual interfaces excluded. Bond and member interfaces can overlap." />
      <Rates title="Disk I/O" channels={disk} io={metrics?.io} graph={metrics?.graphs?.disk} hint="Whole block devices; partitions, loop and device-mapper layers excluded." />
    </div>
    {!!metrics?.io?.warnings.length && <p className="text-xs text-muted-foreground">{[...new Set(metrics.io.warnings)].join(" · ")}</p>}
  </div>
}
