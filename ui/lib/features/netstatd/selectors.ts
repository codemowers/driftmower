import type { ClusterResource } from "@/lib/cluster/cluster-state"

export type WorkloadScope = {
  podUids: Set<string>
  podIPs: Set<string>
  nodes: Set<string>
}

export function findDescendantPodUids(
  resources: ClusterResource[] | null,
  rootUid: string,
): WorkloadScope {
  const podUids = new Set<string>()
  const podIPs = new Set<string>()
  const nodes = new Set<string>()

  if (!resources) {
    return { podUids, podIPs, nodes }
  }

  const childIndex = new Map<string, ClusterResource[]>()
  for (const r of resources) {
    if (!r.ownerUID) continue
    const list = childIndex.get(r.ownerUID) ?? []
    list.push(r)
    childIndex.set(r.ownerUID, list)
  }

  function walk(uid: string) {
    const children = childIndex.get(uid) ?? []
    for (const child of children) {
      if (child.kind === "Pod") {
        podUids.add(child.uid)
        for (const ip of child.ips ?? []) podIPs.add(ip)
        if (child.nodeName) nodes.add(child.nodeName)
      }
      walk(child.uid)
    }
  }
  walk(rootUid)

  return { podUids, podIPs, nodes }
}
