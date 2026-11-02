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

export function collectOwnedPods(resources: ClusterResource[], rootUid: string): ClusterResource[] {
  const childIndex = new Map<string, ClusterResource[]>()
  for (const r of resources) {
    if (!r.ownerUID) continue
    const list = childIndex.get(r.ownerUID)
    if (list) list.push(r)
    else childIndex.set(r.ownerUID, [r])
  }

  const pods: ClusterResource[] = []
  function collect(uid: string) {
    for (const child of childIndex.get(uid) ?? []) {
      if (child.kind === "Pod") pods.push(child)
      collect(child.uid)
    }
  }
  collect(rootUid)
  return pods
}
