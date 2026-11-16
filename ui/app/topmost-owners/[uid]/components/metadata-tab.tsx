import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { supportsYamlView } from "@/lib/features/yaml/supported-kinds"
import YamlViewer from "@/app/yaml/[uid]/components/yaml-viewer"
import ClusterDataPending from "@/app/components/cluster-data-pending"

type Props = {
  clusterResources: ClusterResource[] | null
  liveWorkloadUid: string
}

// The workload's live manifest, without status and server-managed fields.
export default function MetadataTab({ clusterResources, liveWorkloadUid }: Props) {
  if (clusterResources === null) return <ClusterDataPending />
  const resource = clusterResources.find(r => r.uid === liveWorkloadUid)
  if (!resource) return <p className="text-sm text-muted-foreground">No data for this workload.</p>
  if (!supportsYamlView(resource.kind)) return <p className="text-sm text-muted-foreground">The manifest is not available for {resource.kind} resources.</p>
  return <YamlViewer uid={resource.uid} kind={resource.kind} namespace={resource.namespace} name={resource.name} />
}
