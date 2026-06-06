import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

type Props = {
  clusterResources: ClusterResource[] | null
  workloadUid: string
  reportId: string | null
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

export default function PodsTab({ clusterResources, workloadUid, reportId }: Props) {
  if (clusterResources === null) {
    return <p className="text-sm text-muted-foreground">Loading cluster data…</p>
  }

  const childIndex = new Map<string, ClusterResource[]>()
  for (const r of clusterResources) {
    if (!r.ownerUID) continue
    const list = childIndex.get(r.ownerUID) ?? []
    list.push(r)
    childIndex.set(r.ownerUID, list)
  }

  const pods: ClusterResource[] = []
  function collectPods(uid: string) {
    for (const child of childIndex.get(uid) ?? []) {
      if (child.kind === "Pod") pods.push(child)
      collectPods(child.uid)
    }
  }
  collectPods(workloadUid)

  if (pods.length === 0) {
    return <p className="text-sm text-muted-foreground">No pods found.</p>
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      {pods.map((pod, idx) => {
        const href = reportId
          ? `/topmost-owners/${workloadUid}/${pod.uid}?report=${reportId}`
          : `/topmost-owners/${workloadUid}/${pod.uid}`
        return (
          <Link
            key={pod.uid}
            href={href}
            className={cn(
              "grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-brand-bg/30",
              idx > 0 && "border-t border-gray-100",
            )}
          >
            <span className={cn("w-2 h-2 rounded-full shrink-0", PHASE_DOT[pod.phase ?? ""] ?? "bg-gray-400")} />
            <span className="truncate font-mono text-sm text-foreground">{pod.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{pod.nodeName ?? "—"}</span>
            <span className="font-mono text-xs text-muted-foreground">{pod.ips?.[0] ?? "—"}</span>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </Link>
        )
      })}
    </div>
  )
}
