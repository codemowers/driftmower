import { ExternalLink } from "lucide-react"
import type { K8sReference } from "@/lib/api/cluster-resources/types"

export default function ClusterHeader({
  reference,
  provider,
  eolProduct,
  nodeCount,
}: {
  reference: K8sReference | null
  provider: string
  eolProduct: string
  nodeCount: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-1 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
      <span className="font-mono font-medium text-foreground">{provider}</span>
      {reference ? (
        <>
          <Ref label="stable" version={reference.stable} />
          <Ref label="latest" version={reference.latest} />
          {nodeCount > 0 && <Ref label="nodes" version={String(nodeCount)} />}
        </>
      ) : (
        <span className="text-muted-foreground">Version reference unavailable.</span>
      )}
      <a
        href={`https://endoflife.date/${eolProduct}`}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
      >
        endoflife.date
        <ExternalLink className="size-3" aria-hidden />
      </a>
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
