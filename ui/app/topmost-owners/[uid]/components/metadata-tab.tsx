import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { supportsYamlView } from "@/lib/features/yaml/supported-kinds"
import YamlLink from "@/app/components/yaml-link"
import ClusterDataPending from "@/app/components/cluster-data-pending"

type Props = {
  clusterResources: ClusterResource[] | null
  liveWorkloadUid: string
}

export default function MetadataTab({ clusterResources, liveWorkloadUid }: Props) {
  if (clusterResources === null) {
    return <ClusterDataPending />
  }

  const resource = clusterResources.find(r => r.uid === liveWorkloadUid)

  if (!resource) {
    return <p className="text-sm text-muted-foreground">No data for this workload.</p>
  }

  const text = JSON.stringify(resource, null, 2)

  return (
    <div className="relative">
      {supportsYamlView(resource.kind) && (
        <YamlLink
          uid={resource.uid}
          className="absolute right-3 top-2.5 rounded-md bg-gray-50/90 px-1.5 py-1"
        />
      )}
      <pre className="overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-xs text-foreground">
        {text}
      </pre>
    </div>
  )
}
