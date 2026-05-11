import type { ExplorerResource } from "../cluster-state"

export type WorkloadScope = {
  podUids: Set<string>
  podIPs: Set<string>
  containerUidByPodUid: Map<string, string[]>
}

export function findDescendantPodUids(
  resources: ExplorerResource[] | null,
  rootUid: string,
): WorkloadScope {
  const podUids = new Set<string>()
  const podIPs = new Set<string>()
  const containerUidByPodUid = new Map<string, string[]>()

  if (!resources) {
    return { podUids, podIPs, containerUidByPodUid }
  }

  const childIndex = new Map<string, ExplorerResource[]>()
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
      }
      walk(child.uid)
    }
  }
  walk(rootUid)

  return { podUids, podIPs, containerUidByPodUid }
}

export type EndpointKind =
  | { kind: "self"; podUid: string }
  | { kind: "in-cluster"; podUid: string; ownerUid: string | null }
  | { kind: "host"; nodeName: string }
  | { kind: "external" }

export function classifyEndpoint(
  ip: string,
  ourPodIPs: Set<string>,
  resources: ExplorerResource[] | null,
  hostIPs: Map<string, Set<string>>,
): EndpointKind {
  if (ourPodIPs.has(ip)) {
    const pod = resources?.find(r => r.kind === "Pod" && r.ips?.includes(ip))
    return { kind: "self", podUid: pod?.uid ?? "" }
  }

  if (resources) {
    for (const r of resources) {
      if (r.kind === "Pod" && r.ips?.includes(ip)) {
        return { kind: "in-cluster", podUid: r.uid, ownerUid: topmostOwner(r, resources) }
      }
    }
  }

  for (const [nodeName, ips] of hostIPs) {
    if (ips.has(ip)) return { kind: "host", nodeName }
  }

  return { kind: "external" }
}

function topmostOwner(pod: ExplorerResource, resources: ExplorerResource[]): string | null {
  const byUid = new Map(resources.map(r => [r.uid, r]))
  let cur: ExplorerResource | undefined = pod
  while (cur?.ownerUID) {
    const next = byUid.get(cur.ownerUID)
    if (!next) break
    cur = next
  }
  return cur && cur.uid !== pod.uid ? cur.uid : null
}
