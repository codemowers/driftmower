import type { ExplorerResource } from "@/lib/cluster/cluster-state"

type Props = {
  explorerResources: ExplorerResource[] | null
  workloadUid: string
}

export default function MetadataTab({ explorerResources, workloadUid }: Props) {
  if (explorerResources === null) {
    return <p className="text-sm text-muted-foreground">Loading cluster data…</p>
  }

  const resource = explorerResources.find(r => r.uid === workloadUid)

  if (!resource) {
    return <p className="text-sm text-muted-foreground">No data for this workload in the explorer.</p>
  }

  const text = JSON.stringify(resource, null, 2)

  return (
    <pre className="overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-xs text-foreground">
      {text}
    </pre>
  )
}
