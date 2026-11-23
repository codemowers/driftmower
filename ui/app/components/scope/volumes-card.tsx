"use client"

import { useEffect, useState } from "react"
import Card from "@/app/components/layout/card"
import CommandRow from "@/app/components/command-row"
import MetricBar from "@/app/components/metric-bar"
import PrefetchLink from "@/app/components/prefetch-link"
import { callTool } from "@/browser/connection"
import { useClusterState, type ClusterResource } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import { formatBytes } from "@/lib/utils/format-bytes"
import { operatorResizeAdapter, operatorResizeCommands } from "@/lib/features/volumes/operator-resize"
import type { Claim } from "@/lib/features/volumes/types"

// The UID at the top of a Pod's ownership chain, for the Pod view's URL.
function topOwnerUid(resources: ClusterResource[] | null, podUid: string): string | null {
  const byUid = new Map((resources ?? []).map(r => [r.uid, r]))
  let current = byUid.get(podUid)
  if (!current) return null
  while (current.ownerUID && byUid.has(current.ownerUID)) current = byUid.get(current.ownerUID)!
  return current.uid
}

type Operator = { kind: string; apiVersion?: string; name: string }

// PersistentVolumeClaims of a scope: the whole namespace, or those mounted by
// a workload's or Pod's Pods. For operator-managed workloads (CNPG, Redpanda,
// Dragonfly, RabbitMQ) it adds +20/50/100% commands that patch the custom
// resource's declared size, since the operator owns the claims.
export default function VolumesCard({ namespace, pods, operator }: { namespace: string; pods?: string[]; operator?: Operator }) {
  const resources = useClusterState(s => s.clusterResources)
  const connection = useKubectlConnection()
  const { linkTo } = useContextHref()
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; claims: Claim[] }>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    callTool<{ claims: Claim[] }>("list_volumes", { namespace })
      .then(r => { if (!cancelled) setState({ status: "ready", claims: [...r.claims].sort((a, b) => a.name.localeCompare(b.name)) }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [namespace])

  const podSet = pods ? new Set(pods) : null
  const claims = state.status === "ready" ? state.claims.filter(c => !podSet || c.usedBy.some(p => podSet.has(p.name))) : []
  const resizable = operator && operatorResizeAdapter(operator.kind, operator.apiVersion)
  const resizes = resizable && state.status === "ready" ? operatorResizeCommands({ ...operator, namespace }, pods ?? [], state.claims, connection) : []
  // Resource pages without volumes omit the card; the namespace always shows it.
  if (podSet && state.status === "ready" && claims.length === 0 && !resizable) return null

  return (
    <Card title="Volumes" meta={state.status === "ready" ? `${claims.length} ${claims.length === 1 ? "claim" : "claims"}` : undefined}>
      {state.status === "loading" && <p className="text-sm text-muted-foreground">Loading volumes…</p>}
      {state.status === "error" && <p role="alert" className="text-sm text-status-major-label">Volumes could not be loaded: {state.message}</p>}
      {state.status === "ready" && claims.length === 0 && <p className="text-sm text-muted-foreground">{podSet ? "No claims are mounted by these Pods." : "No PersistentVolumeClaims in this namespace."}</p>}
      {claims.map(c => {
        const { usedBytes, capacityBytes } = c.usage
        return (
          <div key={c.uid} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="flex items-baseline gap-2">
                <PrefetchLink href={linkTo(`/volumes/pvc/${encodeURIComponent(c.namespace)}/${encodeURIComponent(c.name)}`)} className="font-mono text-xs text-brand-text hover:underline">{c.name}</PrefetchLink>
                {c.storageClass && <span className="font-mono text-xs text-muted-foreground">{c.storageClass}</span>}
                {c.phase && c.phase !== "Bound" && <span className="text-xs text-status-minor-label">{c.phase}</span>}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {[usedBytes !== null ? `${formatBytes(usedBytes)} used` : null, c.provisionedStorage ?? c.requestedStorage].filter(Boolean).join(" · ")}
              </span>
            </div>
            {usedBytes !== null && capacityBytes ? <MetricBar value={usedBytes} total={capacityBytes} label={`${c.name} usage`} /> : null}
            {!podSet && c.usedBy.length > 0 && (
              <div className="flex flex-wrap gap-x-3">
                {c.usedBy.map(p => {
                  const owner = topOwnerUid(resources, p.uid)
                  return owner
                    ? <PrefetchLink key={p.uid} href={linkTo(`/topmost-owners/${owner}/${p.uid}`)} className="font-mono text-xs text-brand-text hover:underline">{p.name}</PrefetchLink>
                    : <span key={p.uid} className="font-mono text-xs text-muted-foreground">{p.name}</span>
                })}
              </div>
            )}
          </div>
        )
      })}
      {resizes.map(resize => (
        <div key={resize.label} className="flex flex-col gap-2.5 border-t border-gray-100 pt-4">
          <p className="text-sm">Grow {resize.label} volumes <span className="font-mono text-xs text-muted-foreground">currently {resize.current}</span></p>
          {!resize.expandable && <p className="text-xs text-status-minor-label">The storage class of at least one claim does not allow volume expansion; the operator cannot grow it in place.</p>}
          {resize.steps.map(step => <CommandRow key={step.percent} label={`+${step.percent}% → ${step.size}`} value={step.command} />)}
        </div>
      ))}
      {resizes.length > 0 && <p className="text-xs text-muted-foreground">The commands patch the {operator!.kind} resource, whose operator resizes each claim. Sizes are absolute, so running a command again does not grow storage further.</p>}
    </Card>
  )
}
