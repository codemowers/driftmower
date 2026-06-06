import type { ClusterResource } from "./cluster-state"

export function findWorkloadRoot(
  resources: ClusterResource[] | null,
  root: { uid?: string; kind: string; name: string; namespace: string },
): ClusterResource | undefined {
  if (!resources) return undefined
  return (
    (root.uid ? resources.find(r => r.uid === root.uid) : undefined) ??
    resources.find(r => r.kind === root.kind && r.name === root.name && r.namespace === root.namespace)
  )
}
