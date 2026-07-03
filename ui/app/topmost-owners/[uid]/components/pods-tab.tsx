import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { collectOwnedPods } from "@/lib/cluster/workload-root"

type Props = {
  clusterResources: ClusterResource[] | null
  reportWorkloadUid: string
  liveWorkloadUid: string
  contextQuery: string
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

export default function PodsTab({ clusterResources, reportWorkloadUid, liveWorkloadUid, contextQuery }: Props) {
  if (clusterResources === null) {
    return <p className="text-sm text-muted-foreground">Loading cluster data…</p>
  }

  const pods = collectOwnedPods(clusterResources, liveWorkloadUid)

  if (pods.length === 0) {
    return <p className="text-sm text-muted-foreground">No pods found.</p>
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      {pods.map((pod, idx) => {
        const href = `/topmost-owners/${reportWorkloadUid}/${pod.uid}${contextQuery}`
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
