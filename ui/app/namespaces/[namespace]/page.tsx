"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import Card from "@/app/components/layout/card"
import { NamespaceNav } from "@/app/components/layout/resource-navs"
import GraphLink from "@/app/components/graph-link"
import { ResourceGauge } from "@/app/components/prometheus-resource-usage-card"
import SubjectLink from "@/app/users/components/subject-link"
import VolumesCard from "@/app/components/scope/volumes-card"
import { relativeTimeFromNow } from "@/lib/utils/format-time"
import type { Subject } from "@/lib/features/users/types"
import DetailLayout from "@/app/components/layout/detail-layout"
import ScopeFindings from "@/app/components/findings/scope-findings"
import AlertsCard from "@/app/components/findings/alerts-card"
import ResourceCommandsCard from "@/app/components/resource-commands-card"
import { StatGrid, StatCell, StatValue, StatCaption } from "@/app/components/stats-card"
import { aggregateIssues, scopeImageIssues } from "@/lib/cluster/scope"
import { driftStats } from "@/lib/cluster/drift-stats"
import { useScopeUsages } from "@/lib/hooks/use-scope"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import ImagesCard from "@/app/components/scope/images-card"
import PodsCard from "@/app/components/scope/pods-card"
import { fetchMcpJSON } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { formatBytes } from "@/lib/utils/format-bytes"
import { namespacePods, namespaceWorkloadRoots } from "@/lib/features/namespaces/inventory"

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

export default function NamespacePage() {
  const { namespace } = useParams<{ namespace: string }>()
  const name = decodeURIComponent(namespace)
  const { linkTo } = useContextHref()
  const clusterResources = useClusterState(s => s.clusterResources)
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; resources: NamespaceResources }>({ status: "loading" })

  const load = useCallback(() => fetchMcpJSON<NamespaceResources>(`/api/observability/namespace-resources?namespace=${encodeURIComponent(name)}`)
    .then(resources => setState({ status: "ready", resources }))
    .catch((e: unknown) => setState({ status: "error", message: e instanceof Error ? e.message : String(e) })), [name])
  useEffect(() => { void load() }, [load])

  const data = useClusterState(s => s.data)
  const pods = namespacePods(clusterResources ?? [], name)
  const usages = useScopeUsages({ kind: "namespace", namespace: name })
  const drift = driftStats(usages ?? [])
  const workloads = namespaceWorkloadRoots(data, clusterResources).filter(root => root.namespace === name)
  const containers = usages?.length ?? 0
  const resourceIssues = aggregateIssues(pods)
  const namespaceIssueCount = resourceIssues.length + (usages && data ? scopeImageIssues(data.issues, usages).length : 0)
  const failing = pods.filter(p => p.issues?.some(i => i.severity === "critical")).length

  return (
    <>
      <Page>
        <ResourceHeader
          icon={ICONS.namespaces}
          iconAriaLabel="Namespace"
          title={name}
          copyValue={name}
          breadcrumbs={[{ label: "Namespaces", href: linkTo("/namespaces") }, { label: `Namespace ${name}` }]}
          chips={[{ label: "Namespace", tone: "brand" }]}
          issueCount={namespaceIssueCount}
          subtitle={state.status === "ready" && (state.resources.createdBy || state.resources.createdAt) ? (
            <span className="flex flex-wrap items-center gap-1.5">
              Created
              {state.resources.createdBy && <>by <SubjectLink subject={state.resources.createdBy} /></>}
              {state.resources.createdAt && <time dateTime={state.resources.createdAt} title={new Date(state.resources.createdAt).toLocaleString()}>{relativeTimeFromNow(state.resources.createdAt)}</time>}
            </span>
          ) : "Namespace"}
        />
        <NamespaceNav namespace={name} />

        <DetailLayout
          main={<>
            <ResourceCommandsCard kind="Namespace" namespace="" name={name} />
            <AlertsCard scope={{ namespace: name }} hideWhenEmpty />
            <ScopeFindings scope={{ kind: "namespace", namespace: name }} resourceIssues={resourceIssues} />
            <ImagesCard usages={usages ?? []} showWorkload />
            <PodsCard pods={clusterResources ? pods : null} resources={clusterResources} />
            <VolumesCard namespace={name} />
          </>}
          aside={<>
            <StatGrid vertical>
              <StatCell label="Workloads">
                <StatValue>{data ? workloads.length : "—"}</StatValue>
                <StatCaption>{drift.distinctRepoCount ? `${drift.staleRepoCount} of ${drift.distinctRepoCount} image repositories stale` : "no image repositories"}</StatCaption>
              </StatCell>
              <StatCell label="Pods">
                <StatValue>{clusterResources ? pods.length : "—"}</StatValue>
                <StatCaption>{containers} {containers === 1 ? "container" : "containers"}{failing ? ` · ${failing} with critical issues` : ""}</StatCaption>
              </StatCell>
            </StatGrid>
            {state.status === "loading" && <Card title="Namespace resources"><LoadingLine loading="namespace resources" /></Card>}
            {state.status === "error" && <LoadError message={`Failed to load resources: ${state.message}`} onRetry={() => { setState({ status: "loading" }); void load() }} />}
            {state.status === "ready" && (() => {
              const r = state.resources
              const q = (key: string) => r.queries[key]
              return (
                <Card title="Namespace resources">
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
                </Card>
              )
            })()}
          </>}
        />
      </Page>
    </>
  )
}
