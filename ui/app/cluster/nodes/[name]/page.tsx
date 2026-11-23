"use client"

import { useCallback } from "react"
import { useParams } from "next/navigation"
import { callTool } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useKubeconfigState } from "@/lib/kubernetes/context-state"
import { useQuery } from "@/lib/hooks/use-query"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { nodeState } from "@/lib/cluster-resources/node-state"
import type { HealthNode } from "@/lib/features/cluster/load"
import type { PersistentVolume } from "@/lib/features/volumes/types"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import Page from "@/app/components/layout/page"
import Card from "@/app/components/layout/card"
import DetailLayout from "@/app/components/layout/detail-layout"
import { ICONS } from "@/app/components/layout/icons"
import ResourceHeader from "@/app/components/resource-header"
import PrefetchLink from "@/app/components/prefetch-link"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"

type NodeDetail = { node: HealthNode; labels: Record<string, string>; persistentVolumes: PersistentVolume[]; volumesAvailable: boolean; warnings: string[] }

function StateText({ state }: { state: ReturnType<typeof nodeState> }) {
  return <>{state.states.map((item, index) => <span key={item.label}>{index > 0 && ", "}<span className={item.className}>{item.label}</span></span>)}</>
}

function Timestamp({ value }: { value: string | null }) {
  if (!value) return <>—</>
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <>—</>
  return <span className="flex flex-col gap-1"><time dateTime={value}>{date.toLocaleString()}</time><span className="text-xs text-muted-foreground">{compactRelativeTimeFromNow(value)}</span></span>
}

export default function NodePage() {
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params.name)
  const connected = useClusterState(s => s.isConnected)
  const cluster = useClusterState(s => s.clusterName)
  const endpoint = useKubeconfigState(s => s.endpoint)
  const identity = useKubeconfigState(s => s.selectedKey)
  const { linkTo } = useContextHref()
  const load = useCallback((signal: AbortSignal) => callTool<NodeDetail>("get_node", { name }, signal), [name])
  const current = useQuery({ key: connected ? JSON.stringify([endpoint, identity, cluster, "node", name]) : null, load, interval: 30_000, keepDataOnError: false })
  const detail = current.data
  const node = detail?.node
  const bootTime = node?.bootTimeSeconds != null && Number.isFinite(node.bootTimeSeconds) && node.bootTimeSeconds > 0 ? new Date(node.bootTimeSeconds * 1000).toISOString() : null
  const state = node ? nodeState(node) : null

  return <Page>
    <ResourceHeader icon={ICONS.nodes} iconAriaLabel="Node" title={name} copyValue={name} breadcrumbs={[{ label: "Nodes", href: linkTo("/cluster") }, { label: name }]} subtitle={state ? <StateText state={state} /> : "Node details"} />
    {!connected && <p className="text-sm text-muted-foreground">Waiting for cluster connection.</p>}
    {current.loading && <LoadingLine loading="node details" />}
    {current.error && <LoadError message={`Could not load node: ${current.error}`} />}
    {detail && node && <DetailLayout main={<>
      <Card title="Persistent volumes" meta={detail.volumesAvailable ? detail.persistentVolumes.length : "Unavailable"} flush>
        <p className="px-5 py-3 text-xs text-muted-foreground">Volumes with required host affinity matching this node. Shared and zone-only storage is excluded.</p>
        {!detail.volumesAvailable ? <p className="px-5 pb-4 text-sm text-muted-foreground">Host volume inventory is unavailable.</p> : detail.persistentVolumes.length === 0 ? <p className="px-5 pb-4 text-sm text-muted-foreground">No persistent volumes with matching host affinity.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="bg-muted text-xs text-muted-foreground"><tr>{["Name", "State", "Capacity", "Storage class", "Claim"].map(h => <th key={h} className="px-5 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>{detail.persistentVolumes.map(pv => <tr key={pv.uid} className="border-b last:border-0">
            <td className="px-5 py-3 font-mono text-xs"><PrefetchLink href={linkTo(`/volumes/pv/${encodeURIComponent(pv.name)}`)} className="text-brand hover:underline">{pv.name}</PrefetchLink></td>
            <td className="px-5 py-3">{pv.phase ?? "—"}</td><td className="px-5 py-3 font-mono text-xs">{pv.capacityStorage ?? "—"}</td><td className="px-5 py-3 font-mono text-xs">{pv.storageClass ?? "—"}</td>
            <td className="px-5 py-3 font-mono text-xs">{pv.claim ? <PrefetchLink href={linkTo(`/volumes/pvc/${encodeURIComponent(pv.claim.namespace)}/${encodeURIComponent(pv.claim.name)}`)} className="text-brand hover:underline">{pv.claim.namespace}/{pv.claim.name}</PrefetchLink> : "—"}</td>
          </tr>)}</tbody>
        </table></div>}
      </Card>
      <Card title="Labels" meta={Object.keys(detail.labels).length} flush>
        {Object.keys(detail.labels).length ? <dl className="divide-y">{Object.entries(detail.labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => <div key={key} className="grid grid-cols-2 gap-4 px-5 py-3 font-mono text-xs"><dt className="break-all text-muted-foreground">{key}</dt><dd className="break-all">{value || '""'}</dd></div>)}</dl> : <p className="px-5 py-4 text-sm text-muted-foreground">No labels reported.</p>}
      </Card>
      <Card title="Kernel logs"><p className="text-sm text-muted-foreground">Kernel logs are not available yet.</p></Card>
    </>} aside={<>
      <Card title="Node details"><dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-4 text-sm">
        <dt className="text-muted-foreground">State</dt><dd>{state && <StateText state={state} />}</dd>
        <dt className="text-muted-foreground">Roles</dt><dd>{node.roles.join(", ") || "worker"}</dd>
        <dt className="text-muted-foreground">Cluster membership</dt><dd><Timestamp value={node.creationTimestamp || null} /></dd>
        <dt className="text-muted-foreground">Last boot</dt><dd><Timestamp value={bootTime} /></dd>
        <dt className="text-muted-foreground">Kubelet</dt><dd className="break-all font-mono text-xs">{node.kubeletVersion || "—"}</dd>
        <dt className="text-muted-foreground">OS image</dt><dd className="break-words">{node.osImage || "—"}</dd>
        <dt className="text-muted-foreground">Kernel</dt><dd className="break-all font-mono text-xs">{node.kernelVersion || "—"}</dd>
        <dt className="text-muted-foreground">Runtime</dt><dd className="break-all font-mono text-xs">{node.containerRuntime || "—"}</dd>
        <dt className="text-muted-foreground">Architecture</dt><dd>{node.architecture || "—"}</dd>
      </dl></Card>
      {detail.warnings.length > 0 && <Card title="Unavailable data">{detail.warnings.map(w => <p key={w} className="text-sm text-muted-foreground">{w}</p>)}</Card>}
    </>} />}
  </Page>
}
