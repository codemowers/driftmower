"use client"

import { useEffect, useState } from "react"
import { callTool } from "@/browser/connection"
import LoadingLine from "@/app/components/loading-line"
import PrefetchLink from "@/app/components/prefetch-link"
import { useClusterState, type ClusterResource } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { formatBytes } from "@/lib/utils/format-bytes"
import { usageBarColor } from "@/lib/utils/usage-color"

type Claim = {
  name: string
  uid: string
  phase: string | null
  storageClass: string | null
  requestedStorage: string | null
  provisionedStorage: string | null
  usage: { usedBytes: number | null; capacityBytes: number | null }
  usedBy: { name: string; uid: string }[]
}

// The UID at the top of a Pod's ownership chain, for the pod view's URL.
function topOwnerUid(resources: ClusterResource[] | null, podUid: string): string | null {
  const byUid = new Map((resources ?? []).map(r => [r.uid, r]))
  let current = byUid.get(podUid)
  if (!current) return null
  while (current.ownerUID && byUid.has(current.ownerUID)) current = byUid.get(current.ownerUID)!
  return current.uid
}

// The namespace's PersistentVolumeClaims, from the claims alone: class,
// size, kubelet-reported use and the Pods mounting them.
export default function NamespaceVolumes({ namespace }: { namespace: string }) {
  const resources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; claims: Claim[] }>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    callTool<{ claims: Claim[] }>("list_volumes", { namespace })
      .then(r => { if (!cancelled) setState({ status: "ready", claims: [...r.claims].sort((a, b) => a.name.localeCompare(b.name)) }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [namespace])

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Volumes</span>
        {state.status === "ready" && <span className="text-xs tabular-nums text-muted-foreground">{state.claims.length} claims</span>}
      </header>
      <div className="px-5 py-4">
        {state.status === "loading" && <LoadingLine loading="volumes" />}
        {state.status === "error" && <p className="text-sm text-muted-foreground">Volumes could not be loaded: {state.message}</p>}
        {state.status === "ready" && state.claims.length === 0 && <p className="text-sm text-muted-foreground">No PersistentVolumeClaims in this namespace.</p>}
        {state.status === "ready" && state.claims.length > 0 && (
          <div className="flex flex-col gap-3">
            {state.claims.map(c => {
              const { usedBytes, capacityBytes } = c.usage
              const ratio = usedBytes !== null && capacityBytes ? usedBytes / capacityBytes : null
              return (
                <div key={c.uid} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-foreground">{c.name}</span>
                      {c.storageClass && <span className="font-mono text-xs text-muted-foreground">{c.storageClass}</span>}
                      {c.phase && c.phase !== "Bound" && <span className="text-xs text-status-minor-label">{c.phase}</span>}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {[usedBytes !== null ? `${formatBytes(usedBytes)} used` : null, c.provisionedStorage ?? c.requestedStorage].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {ratio !== null && (
                    <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                      <div className={cn("h-full rounded-full", usageBarColor(ratio))} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
                    </div>
                  )}
                  {c.usedBy.length > 0 && (
                    <div className="flex flex-wrap gap-x-3">
                      {c.usedBy.map(p => {
                        const owner = topOwnerUid(resources, p.uid)
                        return owner
                          ? <PrefetchLink key={p.uid} href={linkTo(`/topmost-owners/${owner}/${p.uid}`)} className="font-mono text-xs text-brand hover:underline">{p.name}</PrefetchLink>
                          : <span key={p.uid} className="font-mono text-xs text-muted-foreground">{p.name}</span>
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
