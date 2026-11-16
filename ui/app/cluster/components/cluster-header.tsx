import type { NodeDrift } from "@/lib/cluster-resources/types"

// The distribution, recognised from the kubelet version suffix.
function distribution(version: string): string {
  if (version.includes("+k3s")) return "k3s"
  if (version.includes("+rke2")) return "RKE2"
  if (version.includes("-eks-")) return "Amazon EKS"
  if (version.includes("-gke.")) return "Google GKE"
  return "Kubernetes"
}

export default function ClusterHeader({ nodes }: { nodes: NodeDrift[] }) {
  const versions = [...new Set(nodes.map(n => n.version).filter(Boolean))].sort()
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-1 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
      <span className="font-mono font-medium text-foreground">{distribution(versions[0] ?? "")}</span>
      <Ref label={versions.length > 1 ? "versions" : "version"} value={versions.join(", ") || "—"} />
      <Ref label="nodes" value={String(nodes.length)} />
    </div>
  )
}

function Ref({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </span>
  )
}
