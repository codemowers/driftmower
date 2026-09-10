import "server-only"

import { fetchTenantScope } from "@/lib/server/platform-manager-proxy"
import { namespaceFilter } from "@/lib/server/tenant-scope-filter"
import type { PeerRef } from "../types"

export type Viewer = {
  permitted: ((namespace: string) => boolean) | null
  selected: Set<string> | null
}

export async function resolveViewer(selectedNamespaces: string[] | null): Promise<Viewer> {
  return {
    permitted: namespaceFilter(await fetchTenantScope()),
    selected: selectedNamespaces === null ? null : new Set(selectedNamespaces),
  }
}

export function visible(viewer: Viewer, namespace: string | undefined): boolean {
  if (!namespace) return true
  if (viewer.permitted && !viewer.permitted(namespace)) return false
  if (viewer.selected && !viewer.selected.has(namespace)) return false
  return true
}

export function redact(viewer: Viewer, peer: PeerRef): PeerRef {
  if (peer.class !== "workload") return peer
  if (visible(viewer, peer.namespace)) return peer
  return { class: "workload", ownerKind: "Pod", namespace: peer.namespace, restricted: true }
}
