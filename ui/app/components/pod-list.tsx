"use client"

import PrefetchLink from "./prefetch-link"
import IssueIndicator from "./issue-indicator"
import { ResourceIssueList } from "./findings/issues-card"
import { useContextHref } from "@/lib/hooks/use-context-href"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { classifyPod, POD_SEVERITY_STYLE, podStateLabel } from "@/lib/cluster/styles/pod-status-style"
import { cn } from "@/lib/utils/cn"

export default function PodList({ pods, workloadUid, resources = [], bare = false }: { pods: ClusterResource[]; workloadUid?: string; resources?: ClusterResource[]; bare?: boolean }) {
  const { linkTo } = useContextHref()
  const owners = new Map(resources.map(resource => [resource.uid, resource]))
  if (!pods.length) return <p className="text-sm text-muted-foreground">No Pods found.</p>
  return <div role="list" aria-label="Pods" className={bare ? "divide-y divide-gray-100" : "divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white"}>
    {[...pods].sort((a, b) => a.name.localeCompare(b.name)).map(pod => {
      const rootUid = workloadUid ?? pod.ownerUID ?? pod.uid
      const owner = owners.get(rootUid)
      const status = classifyPod(pod)
      return <div key={pod.uid} className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span title={podStateLabel(status, pod.podStatus?.display ?? pod.phase)} className={cn("size-2 shrink-0 rounded-full", POD_SEVERITY_STYLE[status].solid)} />
          <PrefetchLink href={linkTo(`/topmost-owners/${rootUid}/${pod.uid}`, { drop: ["ptab"] })} className="min-w-0 flex-1 truncate font-mono text-sm text-brand-text hover:underline">{pod.name}</PrefetchLink>
          <span className={cn("text-xs", POD_SEVERITY_STYLE[status].text)}>{podStateLabel(status, pod.podStatus?.display ?? pod.phase)}</span>
          {!workloadUid && owner && owner.uid !== pod.uid && <PrefetchLink href={linkTo(`/topmost-owners/${owner.uid}`)} className="text-xs text-muted-foreground hover:underline">{owner.kind} {owner.name}</PrefetchLink>}
          <span className="font-mono text-xs text-muted-foreground">{pod.nodeName ?? "—"}</span>
          <span className="font-mono text-xs text-muted-foreground">{pod.ips?.[0] ?? "—"}</span>
        </div>
        {!!pod.issues?.length && <details className="mt-2 pl-6">
          <summary className="w-fit cursor-pointer text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><IssueIndicator issues={pod.issues} />{pod.issues.length} {pod.issues.length === 1 ? "issue" : "issues"}</span></summary>
          <div className="mt-2"><ResourceIssueList issues={pod.issues} /></div>
        </details>}
      </div>
    })}
  </div>
}
