import type { K8sReference } from "@/lib/api/cluster-resources/types"

export default function ClusterHeader({
  reference,
  provider,
  nodeCount,
}: {
  reference: K8sReference | null
  provider: string
  nodeCount: number
}) {
  if (!reference) {
    return (
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
        <span className="font-mono font-medium text-foreground">{provider}</span>
        <span className="text-muted-foreground">Version reference unavailable.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-1 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
      <span className="font-mono font-medium text-foreground">{provider}</span>
      <Ref label="stable" version={reference.stable} />
      <Ref label="latest" version={reference.latest} />
      {nodeCount > 0 && <Ref label="nodes" version={String(nodeCount)} />}
    </div>
  )
}

function Ref({ label, version }: { label: string; version: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{version}</span>
    </span>
  )
}
