import Link from "next/link"
import { cn } from "@/lib/utils/cn"
import type { ImageUsage, ReleaseInfo } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

type Props = {
  usages: ImageUsage[]
  clusterResources: ClusterResource[] | null
  releaseInfo: ReleaseInfo
  reportId: string | null
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

export default function ResourcesTab({ usages, clusterResources, releaseInfo, reportId }: Props) {
  if (clusterResources === null) {
    return <p className="text-sm text-muted-foreground">Resource data not available</p>
  }

  const workloadRoots = Array.from(
    usages
      .filter(u => u.workloadRootInfo != null)
      .reduce<Map<string, NonNullable<ImageUsage["workloadRootInfo"]>>>((map, u) => {
        const w = u.workloadRootInfo!
        if (!map.has(w.uid)) map.set(w.uid, w)
        return map
      }, new Map())
      .values()
  )

  if (workloadRoots.length === 0) {
    return <p className="text-sm text-muted-foreground">No container data available.</p>
  }

  const resourceMap = new Map(clusterResources.map(r => [r.uid, r]))
  const managerKey = `helm-release:${releaseInfo.namespace}:${releaseInfo.name}`

  const releasePods = clusterResources.filter(
    r => r.kind === "Pod" && r.managerUID === managerKey
  )

  function resolveWorkloadUid(pod: ClusterResource): string | undefined {
    if (!pod.ownerUID) return undefined
    const owner = resourceMap.get(pod.ownerUID)
    if (owner?.kind === "ReplicaSet") return owner.ownerUID
    return pod.ownerUID
  }

  const podsByWorkload = new Map<string, ClusterResource[]>()
  for (const pod of releasePods) {
    const wUid = resolveWorkloadUid(pod)
    if (!wUid) continue
    const list = podsByWorkload.get(wUid) ?? []
    list.push(pod)
    podsByWorkload.set(wUid, list)
  }

  return (
    <div className="flex flex-col gap-6">
      {workloadRoots.map(w => {
        const pods = podsByWorkload.get(w.uid) ?? []
        const workloadHref = reportId
          ? `/topmost-owners/${w.uid}?report=${reportId}`
          : `/topmost-owners/${w.uid}`

        return (
          <div key={w.uid} className="overflow-hidden rounded-xl border border-gray-200">
            <Link
              href={workloadHref}
              className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2.5 transition-colors hover:bg-brand-bg/30"
            >
              <span className="rounded bg-brand-bg px-1.5 py-0.5 text-xs font-semibold text-brand-label">
                {w.kind}
              </span>
              <span className="text-sm font-semibold text-foreground">{w.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{w.namespace}</span>
            </Link>

            <div>
              {pods.map((pod, idx) => {
                const podHref = reportId
                  ? `/topmost-owners/${w.uid}/${pod.uid}?report=${reportId}`
                  : `/topmost-owners/${w.uid}/${pod.uid}`
                return (
                  <Link
                    key={pod.uid}
                    href={podHref}
                    className={cn(
                      "grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-brand-bg/30",
                      idx > 0 && "border-t border-gray-100",
                    )}
                  >
                    <span className={cn("w-2 h-2 rounded-full shrink-0", PHASE_DOT[pod.phase ?? ""] ?? "bg-gray-400")} />
                    <span className="truncate font-mono text-sm text-foreground">{pod.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{pod.nodeName ?? "—"}</span>
                    <span className="font-mono text-xs text-muted-foreground">{pod.ips?.[0] ?? "—"}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
