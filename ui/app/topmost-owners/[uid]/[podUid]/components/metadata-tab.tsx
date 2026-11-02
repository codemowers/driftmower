import type { ClusterResource } from "@/lib/cluster/cluster-state"
import YamlLink from "@/app/components/yaml-link"

type Props = {
  pod: ClusterResource
}

export default function MetadataTab({ pod }: Props) {
  return (
    <div className="relative">
      <YamlLink uid={pod.uid} className="absolute right-3 top-2.5 rounded-md bg-gray-50/90 px-1.5 py-1" />
      <pre className="overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-xs text-foreground">
        {JSON.stringify(pod, null, 2)}
      </pre>
    </div>
  )
}
