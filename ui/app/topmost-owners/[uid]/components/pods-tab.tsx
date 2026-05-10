import { cn } from "@/lib/utils"
import type { ExplorerResource } from "@/lib/cluster/cluster-state"

type Props = {
  explorerResources: ExplorerResource[] | null
  workloadUid: string
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

export default function PodsTab({ explorerResources, workloadUid }: Props) {
  if (explorerResources === null) {
    return <p className="text-sm text-muted-foreground">Loading cluster data…</p>
  }

  const resourceMap = new Map(explorerResources.map(r => [r.uid, r]))

  function ownsWorkload(pod: ExplorerResource): boolean {
    if (!pod.ownerUID) return false
    if (pod.ownerUID === workloadUid) return true
    const owner = resourceMap.get(pod.ownerUID)
    if (owner?.kind === "ReplicaSet" && owner.ownerUID === workloadUid) return true
    return false
  }

  const pods = explorerResources.filter(r => r.kind === "Pod" && ownsWorkload(r))

  if (pods.length === 0) {
    return <p className="text-sm text-muted-foreground">No pods found.</p>
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      {pods.map((pod, idx) => (
        <div
          key={pod.uid}
          className={cn(
            "grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3",
            idx > 0 && "border-t border-gray-100"
          )}
        >
          <span className={cn("w-2 h-2 rounded-full shrink-0", PHASE_DOT[pod.phase ?? ""] ?? "bg-gray-400")} />
          <span className="truncate font-mono text-sm text-foreground">{pod.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{pod.nodeName ?? "—"}</span>
          <span className="font-mono text-xs text-muted-foreground">{pod.ips?.[0] ?? "—"}</span>
        </div>
      ))}
    </div>
  )
}
