"use client"

import { useEffect, useMemo, useState } from "react"
import PageHeader from "@/app/components/page-header"
import PageLoading from "@/app/components/page-loading"
import PrefetchLink from "@/app/components/prefetch-link"
import SubjectLink from "@/app/users/components/subject-link"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { Subject } from "@/lib/features/users/types"
import { callTool, toolNames } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { namespaceWorkloadRoots,isTerminalPod } from "@/lib/features/namespaces/inventory"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { formatBytes, formatCores } from "@/lib/utils/format-bytes"

type Unset = { cpuRequests: number; cpuLimits: number; memoryRequests: number; memoryLimits: number }
type Summary = { cpuRequests: number | null; memoryRequests: number | null; unset?: Unset; createdBy?: Subject }

// Containers that leave a resource unbounded: missing limits only is yellow,
// missing requests only orange, both red.
function UnsetMark({ requests, limits, resource }: { requests: number; limits: number; resource: string }) {
  if (!requests && !limits) return null
  const className = requests && limits ? "text-status-major" : requests ? "text-status-minor" : "text-status-patch"
  const title = [requests && `${requests} container${requests === 1 ? "" : "s"} without a ${resource} request`, limits && `${limits} without a ${resource} limit`].filter(Boolean).join(", ")
  return (
    <span title={title} className={cn("inline-flex items-center", className)}>
      <AlertTriangle className="size-3.5" aria-label={title} />
    </span>
  )
}

// A bar scaled to the largest namespace, so namespaces compare at a glance,
// then the figure itself.
function Gauge({ value, max, format }: { value: number | null | undefined; max: number; format: (v: number) => string }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-brand" style={{ width: `${max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{format(value)}</span>
    </div>
  )
}

// Every namespace the caller sees workloads in, comparable by what its Pods
// request.
export default function NamespacesPage() {
  const data = useClusterState(s => s.data)
  const resources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()
  const [summaries, setSummaries] = useState<Record<string, Summary> | null>(null)

  const rows = useMemo(() => {
    const out = new Map<string, { workloads: number; pods: number }>()
    const row = (ns: string) => out.get(ns) ?? out.set(ns, { workloads: 0, pods: 0 }).get(ns)!
    for (const root of namespaceWorkloadRoots(data,resources)) row(root.namespace).workloads++
    for (const r of resources ?? []) if (r.kind === "Pod" && !isTerminalPod(r)) row(r.namespace).pods++
    return [...out].sort(([a], [b]) => a.localeCompare(b))
  }, [data, resources])

  const key = rows.map(([ns]) => ns).join(",")
  useEffect(() => {
    if (!key) return
    let cancelled = false
    void (async () => {
      try {
        if (!(await toolNames()).has("get_namespace_summaries")) return
        const r = await callTool<{ namespaces: Record<string, Summary> }>("get_namespace_summaries", { namespaces: key.split(",") })
        if (!cancelled) setSummaries(r.namespaces)
      } catch { /* The columns stay empty. */ }
    })()
    return () => { cancelled = true }
  }, [key])

  if (!data) return <PageLoading loading="namespaces" />
  const values = Object.values(summaries ?? {})
  const max = (pick: (s: Summary) => number | null) => Math.max(0, ...values.map(s => pick(s) ?? 0))
  const maxCPU = max(s => s.cpuRequests), maxMemory = max(s => s.memoryRequests)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Namespaces" subtitle="Namespaces with workloads you can see, by what their Pods request" />
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-semibold">Namespace</th>
                <th className="px-5 py-3 text-right font-semibold">Workloads</th>
                <th className="px-5 py-3 text-right font-semibold">Running Pods</th>
                <th className="px-5 py-3 font-semibold">Created by</th>
                <th className="px-5 py-3 font-semibold">CPU requests</th>
                <th className="px-5 py-3 font-semibold">Memory requests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([ns, counts]) => {
                const s = summaries?.[ns]
                return (
                  <tr key={ns} className="border-t border-gray-100">
                    <td className="px-5 py-2.5">
                      <PrefetchLink href={linkTo(`/namespaces/${encodeURIComponent(ns)}`)} className="font-mono text-brand-text hover:underline">{ns}</PrefetchLink>
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{counts.workloads}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">{counts.pods}</td>
                    <td className="px-5 py-2.5 text-xs">{s?.createdBy ? <SubjectLink subject={s.createdBy} /> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-5 py-2.5"><span className="flex items-center gap-2"><Gauge value={s?.cpuRequests} max={maxCPU} format={formatCores} />{s?.unset && <UnsetMark requests={s.unset.cpuRequests} limits={s.unset.cpuLimits} resource="CPU" />}</span></td>
                    <td className="px-5 py-2.5"><span className="flex items-center gap-2"><Gauge value={s?.memoryRequests} max={maxMemory} format={formatBytes} />{s?.unset && <UnsetMark requests={s.unset.memoryRequests} limits={s.unset.memoryLimits} resource="memory" />}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
