"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useCallback, useRef } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { callTool } from "@/browser/connection"
import VolumeResizeStatus from "./resize-status"
import LoadingLine from "@/app/components/loading-line"
import ResourceHeader from "@/app/components/resource-header"
import CommandSnippet from "@/app/components/command-snippet"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { expandedStorage } from "@/lib/features/volumes/quantity"
import { volumeCommands } from "@/lib/features/volumes/commands"
import { volumePath, type VolumeDetail as Detail } from "@/lib/features/volumes/types"

function Details({ detail }: { detail: Detail }) {
  const connection = useKubectlConnection()
  const { linkTo } = useContextHref()
  const claim = detail.claim
  const pv = detail.persistentVolume
  const commands = volumeCommands(detail, "", connection)
  const expansions = [20, 50, 100].flatMap(percent => {
    const size = claim?.requestedStorage ? expandedStorage(claim.requestedStorage, percent) : null
    const command = size ? volumeCommands(detail, size, connection)?.resize : undefined
    return command ? [{ percent, size, command }] : []
  })
  const policy = pv?.reclaimPolicy ?? detail.storageClass?.reclaimPolicy
  const facts = [
    ["Phase", claim?.phase ?? pv?.phase], ["Requested", claim?.requestedStorage], ["Provisioned", claim?.provisionedStorage ?? pv?.capacityStorage],
    ["Storage class", claim?.storageClass ?? pv?.storageClass], ["Volume mode", claim?.volumeMode ?? pv?.volumeMode],
    ["Access modes", (claim?.accessModes ?? pv?.accessModes)?.join(", ")], ["Reclaim policy", policy], ["CSI driver", pv?.csiDriver],
    ["Affinity", pv?.affinity ? `${pv.affinity.kind}: ${pv.affinity.values.filter(v => v.trim()).join(", ") || "—"}` : undefined], ["UID", claim?.uid ?? pv?.uid],
  ].filter(([, value]) => value)
  return <>
    <section className="rounded-xl border border-gray-200 bg-white p-5"><h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Volume details</h2><dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[160px_1fr]">{facts.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}
      {claim && <><dt className="text-muted-foreground">Claim</dt><dd><Link className="font-mono text-brand-text hover:underline" href={linkTo(volumePath(claim), claim.boundVolume ? { set: { volume: claim.boundVolume } } : undefined)}>{claim.namespace}/{claim.name}</Link></dd></>}
      {pv && <><dt className="text-muted-foreground">PersistentVolume</dt><dd><Link className="font-mono text-brand-text hover:underline" href={linkTo(volumePath(null, pv))}>{pv.name}</Link></dd></>}
    </dl>{claim && <VolumeResizeStatus claim={claim} />}{claim?.usedBy.length ? <p className="mt-4 text-sm text-muted-foreground">Mounted by: {claim.usedBy.map(pod => pod.name).join(", ")}</p> : null}</section>
    {commands && <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Manage with kubectl</h2><p className="text-xs text-muted-foreground">{claim ? "Commands target the existing PVC. Kubernetes and the storage driver reconcile its PersistentVolume." : detail.claimState === "unknown" ? "The claim's existence is unverified; only inspection is offered." : "The original PVC is absent or this PV has no claim. Commands target the PV directly."}</p>
      <CommandSnippet title={`Inspect ${commands.target}`} command={commands.get} open />
      {claim && <div className="space-y-3">
        {expansions.length ? <>{expansions.map(({ percent, size, command }) => <CommandSnippet key={percent} title={`Grow PVC +${percent}% → ${size}`} command={command} open />)}<p className="text-xs text-muted-foreground">Each command sets a fixed storage request; repeating it does not grow the volume again. Expansion is asynchronous. Volumes cannot shrink.</p></> : <p className="text-xs text-muted-foreground">{!detail.storageClass ? "StorageClass expansion support could not be verified." : !detail.storageClass.allowVolumeExpansion ? "This StorageClass does not allow volume expansion." : claim.phase !== "Bound" ? "The claim must be Bound to expand it." : "The storage request is unavailable."}</p>}
      </div>}
      {!claim && <p className="text-xs text-muted-foreground">Expansion requires a PVC. Editing a PV&apos;s advertised capacity does not resize the underlying storage.</p>}
      {commands.remove && <><p className="text-sm text-muted-foreground">{policy === "Delete" ? "The Delete reclaim policy can cause the provisioner to delete the backing storage." : policy === "Retain" ? "The Retain reclaim policy leaves backing storage for manual recovery or cleanup." : "The backing-storage deletion behavior depends on the PV reclaim policy and driver."} {claim && claim.usedBy.length > 0 ? "This claim is mounted; PVC protection can defer deletion until its Pods release it." : ""}</p><CommandSnippet title={`Delete ${commands.target}`} command={commands.remove} /></>}
    </section>}
  </>
}

export default function VolumeDetail({ namespace, claim, volume }: { namespace?: string; claim?: string; volume?: string }) {
  const query = useSearchParams()
  const cluster = useClusterState(s => s.clusterName)
  const { linkTo } = useContextHref()
  const key = JSON.stringify([cluster, namespace, claim, volume, query.get("volume")])
  const fallback = useRef<{ key: string; volume?: string } | null>(null)
  const load = useCallback(async (signal: AbortSignal) => {
    const [, ns, name, explicitVolume, queryVolume] = JSON.parse(key) as (string | undefined)[]
    const retainedVolume = fallback.current?.key === key ? fallback.current.volume : undefined
    const selectedVolume = explicitVolume || queryVolume || retainedVolume
    const detail = await callTool<Detail>("get_volume", { ...(name ? { namespace: ns, claim: name } : {}), ...(selectedVolume ? { volume: selectedVolume } : {}) }, signal)
    if (!signal.aborted) fallback.current = { key, volume: detail.persistentVolume?.name ?? selectedVolume }
    return detail
  }, [key])
  const current = useQuery({ key, load, interval: 30_000, keepDataOnError: false })
  const detail = current.data
  const name = detail?.claim ? `${detail.claim.namespace}/${detail.claim.name}` : detail?.persistentVolume?.name ?? (claim ? `${namespace}/${claim}` : volume ?? "Volume")
  return <Page><ResourceHeader icon={ICONS.volumes} iconAriaLabel="Persistent storage" title={name} breadcrumbs={[{ label: "Volumes", href: linkTo("/volumes") }, { label: name }]} subtitle={detail?.claim ? "PersistentVolumeClaim" : "PersistentVolume"} />
    {current.loading && <LoadingLine loading="volume binding" />}{current?.error && <p role="alert" className="text-sm text-status-major-label">{current.error}</p>}
    {detail?.warnings.map(warning => <p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
    {detail && (detail.claim || detail.persistentVolume) ? <Details key={`${detail.claim?.uid ?? detail.persistentVolume?.uid}/${detail.claim?.requestedStorage}`} detail={detail} /> : detail && <p className="text-sm text-muted-foreground">This claim or volume no longer exists.</p>}
  </Page>
}
