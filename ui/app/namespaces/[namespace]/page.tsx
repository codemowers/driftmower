"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Breadcrumbs from "@/app/components/breadcrumbs"
import GraphLink from "@/app/components/graph-link"
import { ResourceGauge } from "@/app/components/prometheus-resource-usage-card"
import LogsCard from "@/app/components/logs-card"
import SubjectLink from "@/app/users/components/subject-link"
import NamespaceVolumes from "./components/namespace-volumes"
import { relativeTimeFromNow } from "@/lib/utils/format-time"
import type { Subject } from "@/lib/features/users/types"
import WorkloadAdvisories from "@/app/components/workload-advisories"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import PrefetchLink from "@/app/components/prefetch-link"
import { fetchMcpJSON } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { formatBytes } from "@/lib/utils/format-bytes"
import { namespaceWorkloadRoots,isTerminalPod } from "@/lib/features/namespaces/inventory"
import { orphanBuckets } from "@/lib/utils/report-roots"
import { EMPTY_POD_SUMMARY, summarizePodsByRoot } from "@/lib/utils/pods-by-root"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"

type Compute = { quotaRequests: number | null; quotaLimits: number | null; requests: number | null; limits: number | null; usage: number | null }
type NamespaceResources = {
  namespace: string
  createdAt?: string
  createdBy?: Subject
  cpu: Compute
  memory: Compute
  storage: { quota: number | null; capacity: number | null; usage: number | null }
  buckets: { count: number; requests: number | null; usage: number | null }
  queries: Record<string, string>
  warnings: string[]
}

const cores = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} cores`

type Amount = { label: string; value: number | null; query?: string }

// One resource as the Pod and workload cards draw it: usage against the
// largest limit or quota, with the requests and the other ceilings as ticks.
function Resource({ title, usage, request, ceilings, format }: { title: string; usage: Amount; request: Amount | null; ceilings: Amount[]; format: (v: number) => string }) {
  const present = ceilings.filter(c => c.value !== null && c.value > 0)
  const top = present.reduce<Amount | null>((best, c) => (best === null || c.value! > best.value! ? c : best), null)
  return (
    <ResourceGauge label={<GraphLink exprs={usage.query ? [usage.query] : null}>{title}</GraphLink>} fmt={format}
      used={usage.value} requested={request?.value ?? null}
      ceiling={top ? { value: top.value!, label: top.label.toLowerCase() } : null}
      others={present.filter(c => c !== top).map(c => ({ value: c.value!, label: c.label.toLowerCase() }))} />
  )
}

// A workload as one chip: its kind on the brand colour, then its name.
function WorkloadChip({ href, kind, name, orphan, title }: { href: string; kind: string; name: string; orphan?: boolean; title?: string }) {
  return (
    <PrefetchLink href={href} title={title}
      className={cn("inline-flex max-w-full overflow-hidden rounded-md border text-xs", orphan ? "border-status-minor-bg hover:bg-status-minor-bg/50" : "border-brand-bg hover:bg-brand-bg/40")}>
      <span className={cn("shrink-0 px-2 py-1 font-semibold", orphan ? "bg-status-minor-bg text-status-minor-label" : "bg-brand-bg text-brand-label")}>{kind}</span>
      <span className="truncate bg-white/0 px-2 py-1 font-medium">{name}</span>
    </PrefetchLink>
  )
}

export default function NamespacePage() {
  const { namespace } = useParams<{ namespace: string }>()
  const name = decodeURIComponent(namespace)
  const { linkTo } = useContextHref()
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; resources: NamespaceResources }>({ status: "loading" })

  const load = useCallback(() => fetchMcpJSON<NamespaceResources>(`/api/observability/namespace-resources?namespace=${encodeURIComponent(name)}`)
    .then(resources => setState({ status: "ready", resources }))
    .catch((e: unknown) => setState({ status: "error", message: e instanceof Error ? e.message : String(e) })), [name])
  useEffect(() => { void load() }, [load])

  const summaries = summarizePodsByRoot((clusterResources??[]).filter(resource=>!isTerminalPod(resource)))
  const roots = namespaceWorkloadRoots(data,clusterResources).filter(r => r.namespace === name).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  const orphans = orphanBuckets(data).find(b => b.namespace === name)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <Breadcrumbs items={[{ label: "Workloads", href: linkTo("/topmost-owners") }, { label: `Namespace ${name}` }]} />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{name}</h1>
          {state.status === "ready" && (state.resources.createdBy || state.resources.createdAt) && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              Created
              {state.resources.createdBy && <>by <SubjectLink subject={state.resources.createdBy} /></>}
              {state.resources.createdAt && <time dateTime={state.resources.createdAt} title={new Date(state.resources.createdAt).toLocaleString()}>{relativeTimeFromNow(state.resources.createdAt)}</time>}
            </p>
          )}
        </div>

        {state.status === "loading" && <LoadingLine loading="namespace resources" />}
        {state.status === "error" && <LoadError message={`Failed to load resources: ${state.message}`} onRetry={() => { setState({ status: "loading" }); void load() }} />}
        {state.status === "ready" && (() => {
          const r = state.resources
          const q = (key: string) => r.queries[key]
          return (
            <div className="rounded-xl border border-gray-200 bg-white">
              <header className="border-b border-gray-200 px-5 py-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Namespace resources</span>
              </header>
              <div className="flex flex-col gap-4 px-5 py-4">
                {(["cpu", "memory"] as const).map(kind => (
                  <Resource key={kind} title={kind === "cpu" ? "CPU" : "Memory"} format={kind === "cpu" ? cores : formatBytes}
                    usage={{ label: "Usage", value: r[kind].usage, query: q(`${kind}.usage`) }}
                    request={{ label: "Requests", value: r[kind].requests, query: q(`${kind}.requests`) }}
                    ceilings={[
                      { label: "Limits", value: r[kind].limits, query: q(`${kind}.limits`) },
                      { label: "Quota requests", value: r[kind].quotaRequests, query: q(`${kind}.quotaRequests`) },
                      { label: "Quota limits", value: r[kind].quotaLimits, query: q(`${kind}.quotaLimits`) },
                    ]} />
                ))}
                <Resource title="Persistent volume claims" format={formatBytes}
                  usage={{ label: "Usage", value: r.storage.usage, query: q("storage.usage") }}
                  request={null}
                  ceilings={[
                    { label: "Capacity", value: r.storage.capacity, query: q("storage.capacity") },
                    { label: "Quota", value: r.storage.quota, query: q("storage.quota") },
                  ]} />
                <Resource title={`Buckets${r.buckets.count ? ` · ${r.buckets.count}` : ""}`} format={formatBytes}
                  usage={{ label: "Usage", value: r.buckets.usage, query: q("buckets.usage") }}
                  request={null}
                  ceilings={[{ label: "Quota", value: r.buckets.requests, query: q("buckets.requests") }]} />
                {r.warnings.length > 0 && <ul className="border-t border-gray-100 pt-3 text-xs text-muted-foreground">{r.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
              </div>
            </div>
          )
        })()}

        <NamespaceVolumes namespace={name} />


        <WorkloadAdvisories namespace={name} />

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workloads · {roots.length}</h2>
          {roots.length === 0 && !orphans
            ? <p className="text-sm text-muted-foreground">No workloads visible in this namespace.</p>
            : (
              <div className="flex flex-wrap gap-2">
                {roots.map(root => {
                  const live = findWorkloadRoot(clusterResources, root)
                  const pods = live ? summaries.get(live.uid) ?? EMPTY_POD_SUMMARY : null
                  return (
                    <WorkloadChip key={root.uid} href={linkTo(`/topmost-owners/${root.uid}`)} kind={root.kind} name={root.name} orphan={root.orphan}
                      title={pods ? `${pods.total} pod${pods.total === 1 ? "" : "s"}` : undefined} />
                  )
                })}
                {orphans && <WorkloadChip href={linkTo(`/topmost-owners/${orphans.uid}`)} kind="Namespace" name="Orphaned resources" orphan />}
              </div>
            )}
        </section>
        <LogsCard namespace={name} href={linkTo(`/namespaces/${encodeURIComponent(name)}/logs`)} scope="every container in this namespace" />
      </main>
    </div>
  )
}
