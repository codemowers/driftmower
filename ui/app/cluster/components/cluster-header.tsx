import type { K8sReference } from "@/lib/api/cluster-resources/types"

export default function ClusterHeader({ reference }: { reference: K8sReference | null }) {
  if (!reference) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm text-muted-foreground">
        Version reference unavailable. Drift cannot be computed.
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Target</span>
      <Ref label="stable" version={reference.stable} />
      <span className="text-gray-200">·</span>
      <Ref label="latest" version={reference.latest} />
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
