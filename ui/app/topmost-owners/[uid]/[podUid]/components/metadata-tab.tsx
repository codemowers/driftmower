import type { ClusterResource } from "@/lib/cluster/cluster-state"
import YamlViewer from "@/app/yaml/[uid]/components/yaml-viewer"

// The Pod's live manifest, without status and server-managed fields.
export default function MetadataTab({ pod }: { pod: ClusterResource }) {
  return <YamlViewer uid={pod.uid} kind="Pod" namespace={pod.namespace} name={pod.name} />
}
