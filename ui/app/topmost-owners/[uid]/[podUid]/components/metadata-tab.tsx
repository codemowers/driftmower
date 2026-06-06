import type { ClusterResource } from "@/lib/cluster/cluster-state"

type Props = {
  pod: ClusterResource
}

export default function MetadataTab({ pod }: Props) {
  return (
    <pre className="overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-xs text-foreground">
      {JSON.stringify(pod, null, 2)}
    </pre>
  )
}
