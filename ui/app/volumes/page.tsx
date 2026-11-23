"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useCallback, useState } from "react"
import { useQuery } from "@/lib/hooks/use-query"
import CommandSnippet from "@/app/components/command-snippet"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import { volumeCleanupCommands } from "@/lib/features/volumes/commands"
import VolumeResizeStatus from "./components/resize-status"
import MetricBar from "@/app/components/metric-bar"
import PageHeader from "../components/page-header"
import { FilterSearchInput } from "../components/filter-bar"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import PrefetchLink from "@/app/components/prefetch-link"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { callTool } from "@/browser/connection"
import { useClusterState, type ClusterResource } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { formatBytes } from "@/lib/utils/format-bytes"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { prometheusGraphLink } from "@/lib/features/prometheus/links"

import { volumePath, type Claim, type PersistentVolume, type StorageClass, type Volumes } from "@/lib/features/volumes/types"

type Row = { key: string; claim: Claim | null; pv: PersistentVolume | null; space: number | null; inodes: number | null; fullness: number }


function ratio(used: number | null, total: number | null): number | null {
  return used === null || total === null || total <= 0 ? null : used / total
}

// Fullest first: the larger of space and inode use. Claims without metrics
// and PVs without a claim follow, by name.
function rows(v: Volumes): Row[] {
  const pvs = new Map(v.persistentVolumes.map(pv => [pv.name, pv]))
  const out: Row[] = v.claims.map(c => {
    const space = ratio(c.usage.usedBytes, c.usage.capacityBytes)
    const inodes = ratio(c.usage.inodesUsed, c.usage.inodes)
    const pv = c.boundVolume ? pvs.get(c.boundVolume) ?? null : null
    if (pv) pvs.delete(pv.name)
    return { key: `${c.namespace}/${c.name}`, claim: c, pv, space, inodes, fullness: Math.max(space ?? -1, inodes ?? -1) }
  })
  for (const pv of pvs.values()) out.push({ key: `pv/${pv.name}`, claim: null, pv, space: null, inodes: null, fullness: -2 })
  return out.sort((a, b) => b.fullness - a.fullness || a.key.localeCompare(b.key))
}

// The UID at the top of a Pod's ownership chain, for the pod view's URL.
function topOwnerUid(resources: ClusterResource[] | null, podUid: string): string | null {
  if (!resources) return null
  const byUid = new Map(resources.map(r => [r.uid, r]))
  let current = byUid.get(podUid)
  if (!current) return null
  while (current.ownerUID && byUid.has(current.ownerUID)) current = byUid.get(current.ownerUID)!
  return current.uid
}

// A Prometheus graph of the claim's kubelet series over the last week.
function graphLink(base: string | null, claim: Claim, metrics: string): string | null {
  if (!base) return null
  return prometheusGraphLink(base, [`{__name__=~${JSON.stringify(metrics)},namespace=${JSON.stringify(claim.namespace)},persistentvolumeclaim=${JSON.stringify(claim.name)}}`], "1w")
}

// Without a ratio only the label is shown, such as the claim's capacity when
// kubelet reports no usage.
function Meter({ value, label, href }: { value: number | null; label: string | null; href: string | null }) {
  if (!label) return <span className="text-muted-foreground">—</span>
  const text = href
    ? <a href={href} target="_blank" rel="noreferrer" className="text-xs tabular-nums text-brand hover:underline">{label}</a>
    : <div className="text-xs tabular-nums text-muted-foreground">{label}</div>
  if (value === null) return text
  return (
    <div className="min-w-32">
      {text}
      <MetricBar value={value} total={1} className="mt-1 h-1.5" />
    </div>
  )
}

function count(n: number): string {
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`
  if (n >= 1e3) return `${Math.round(n / 100) / 10}k`
  return String(n)
}

function StorageClassCell({ name, info }: { name: string | null; info: StorageClass | undefined }) {
  if (!name) return <span className="text-muted-foreground">—</span>
  if (!info) return <span className="font-mono text-xs text-foreground">{name}</span>
  const lines = [
    ...(Object.keys(info.parameters).length ? ["parameters:", ...Object.entries(info.parameters).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${k}: ${v}`)] : []),
    `provisioner: ${info.provisioner}`,
    `reclaimPolicy: ${info.reclaimPolicy}`,
    `volumeBindingMode: ${info.volumeBindingMode}`,
    `allowVolumeExpansion: ${info.allowVolumeExpansion}`,
    ...(info.mountOptions.length ? ["mountOptions:", ...info.mountOptions.map(o => `  - ${o}`)] : []),
  ]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help font-mono text-xs text-foreground underline decoration-dotted underline-offset-2">{name}</span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-none">
        <pre className="font-mono text-xs leading-relaxed">{lines.join("\n")}</pre>
      </TooltipContent>
    </Tooltip>
  )
}

export default function VolumesPage() {
  const [query, setQuery] = useState("")
  const [showDelete, setShowDelete] = useState(false)
  const connection = useKubectlConnection()
  const resources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()

  const cluster = useClusterState(s => s.clusterName)
  const load = useCallback((signal: AbortSignal) => callTool<Volumes>("list_volumes", { includeUnboundPVs: true }, signal), [])
  const result = useQuery({ key: JSON.stringify([cluster, "volumes"]), load, keepDataOnError: false })
  const state = result.data ? { status: "ready" as const, volumes: result.data } : result.error ? { status: "error" as const, message: result.error } : { status: "loading" as const }

  const prometheusUrl = state.status === "ready" ? state.volumes.prometheusUrl ?? null : null
  const classes = new Map((state.status === "ready" ? state.volumes.storageClasses ?? [] : []).map(c => [c.name, c]))
  const search = query.trim().toLowerCase()
  const visible = state.status === "ready"
    ? rows(state.volumes).filter(r => !search || [
      r.claim && `${r.claim.namespace}/${r.claim.name}`, r.pv?.claim && `${r.pv.claim.namespace}/${r.pv.claim.name}`,
      r.claim?.storageClass, r.pv?.name, r.pv?.storageClass, r.pv?.csiDriver, r.pv?.phase,
      ...(r.pv?.affinity?.values ?? []), ...(r.claim?.usedBy ?? []).map(p => p.name),
    ].filter(Boolean).join(" ").toLowerCase().includes(search))
    : []

  const cleanup = state.status === "ready" ? volumeCleanupCommands(state.volumes, connection) : null

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.volumes} title="Volumes" subtitle="PersistentVolumeClaims and their PersistentVolumes, fullest first, with kubelet space and inode usage" />

        {state.status === "loading" && <LoadingLine loading="volumes" />}
        {state.status === "error" && <LoadError message={`Failed to load volumes: ${state.message}`} onRetry={result.retry} />}

        {state.status === "ready" && (
          <>
            <div className="flex items-center gap-4">
              {!showDelete && <FilterSearchInput value={query} onChange={setQuery} placeholder="Search claim, pod, volume, class, driver, node or zone..." />}
              <label className="flex shrink-0 items-center gap-2 text-xs"><input type="checkbox" checked={showDelete} onChange={event=>setShowDelete(event.target.checked)}/>Clean up commands</label>
            </div>
            {!showDelete && state.volumes.degraded.length > 0 && (
              <ul className="text-sm text-muted-foreground">
                {state.volumes.degraded.map(d => <li key={`${d.source}-${d.message}`}>{d.source}: {d.message}</li>)}
              </ul>
            )}
            {showDelete && cleanup ? (
              <div className="space-y-6">
                <CommandSnippet title="kubectl delete pvc" command={cleanup.pvc} open fullHeight />
                <CommandSnippet title="kubectl delete pv" command={cleanup.pv} open fullHeight />
              </div>
            ) : visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">{search ? "No volumes match that search." : "No PersistentVolumeClaims or PersistentVolumes were found."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">Volume</th>
                      <th className="py-2 pr-4 font-semibold">Storage class</th>
                      <th className="py-2 pr-4 font-semibold">Affinity</th>
                      <th className="py-2 pr-4 font-semibold">Space</th>
                      <th className="py-2 pr-4 font-semibold">Inodes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(({ key, claim, pv, space, inodes }) => (
                      <tr key={key} className={cn("border-t border-border align-top", !claim && "text-muted-foreground opacity-60")}>
                        <td className="py-2 pr-4">
                          <PrefetchLink href={linkTo(volumePath(claim, pv), claim?.boundVolume ? { set: { volume: claim.boundVolume } } : undefined)} className="font-medium text-brand-text hover:underline" title={pv?.name ?? claim?.boundVolume ?? undefined}>
                            {claim ? `${claim.namespace}/${claim.name}` : pv?.claim ? `${pv.claim.namespace}/${pv.claim.name}` : pv?.name ?? "unclaimed"}
                          </PrefetchLink>
                          {!claim && pv && <div className="font-mono text-xs text-muted-foreground">{pv.name}</div>}
                          {claim?.phase && claim.phase !== "Bound" && <div className="text-xs text-muted-foreground">{claim.phase}</div>}
                          {!claim && pv?.phase && (
                            <div className="text-xs" title={pv.lastPhaseTransitionTime ?? undefined}>
                              {pv.phase.toLowerCase()}{pv.lastPhaseTransitionTime && ` ${compactRelativeTimeFromNow(pv.lastPhaseTransitionTime)}`}
                            </div>
                          )}
                          {claim && claim.usedBy.length > 0 && (
                            <div className="flex flex-wrap gap-x-3">
                              {claim.usedBy.map(p => {
                                const owner = topOwnerUid(resources, p.uid)
                                return owner
                                  ? <PrefetchLink key={p.uid} href={linkTo(`/topmost-owners/${owner}/${p.uid}`)} className="font-mono text-xs text-brand hover:underline">{p.name}</PrefetchLink>
                                  : <span key={p.uid} className="font-mono text-xs text-muted-foreground">{p.name}</span>
                              })}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <StorageClassCell name={claim?.storageClass ?? pv?.storageClass ?? null} info={classes.get(claim?.storageClass ?? pv?.storageClass ?? "")} />
                        </td>
                        <td className="py-2 pr-4">
                          {pv?.affinity ? (
                            <>
                              <div className="font-mono text-xs">{pv.affinity.values.filter(v => v.trim()).join(", ") || "—"}</div>
                              <div className="text-xs text-muted-foreground">{pv.affinity.kind}</div>
                            </>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4">
                          <Meter
                            value={space}
                            label={claim?.usage.usedBytes != null && claim.usage.capacityBytes != null
                              ? `${formatBytes(claim.usage.usedBytes)} / ${formatBytes(claim.usage.capacityBytes)}`
                              : (claim ? claim.provisionedStorage ?? claim.requestedStorage : pv?.capacityStorage) ?? null}
                            href={claim && space !== null ? graphLink(prometheusUrl, claim, "kubelet_volume_stats_(used|capacity)_bytes") : null}
                          />
                          {claim && <VolumeResizeStatus claim={claim} />}
                        </td>
                        <td className="py-2 pr-4">
                          <Meter
                            value={inodes}
                            label={claim?.usage.inodesUsed != null && claim.usage.inodes != null ? `${count(claim.usage.inodesUsed)} / ${count(claim.usage.inodes)}` : null}
                            href={claim && inodes !== null ? graphLink(prometheusUrl, claim, "kubelet_volume_stats_inodes(_used)?") : null}
                          />
                        </td>

                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Page>
    </>
  )
}
