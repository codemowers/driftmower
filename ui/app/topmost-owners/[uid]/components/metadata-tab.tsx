import type { ClusterResource } from "@/lib/cluster/cluster-state"

type Props = {
  clusterResources: ClusterResource[] | null
  liveWorkloadUid: string
}

export default function MetadataTab({ clusterResources, liveWorkloadUid }: Props) {
  if (clusterResources === null) {
    return <p className="text-sm text-muted-foreground">Loading cluster data…</p>
  }

  const resource = clusterResources.find(r => r.uid === liveWorkloadUid)

  if (!resource) {
    return <p className="text-sm text-muted-foreground">No data for this workload.</p>
  }

  const text = JSON.stringify(resource, null, 2)

  return (
    <pre className="overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-xs text-foreground">
      {text}
    </pre>
  )
}
