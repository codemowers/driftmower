import "server-only"

import { readScope } from "@/lib/server/sandbox-scope-filter"
import type { PeerRef } from "../types"

export type Viewer = {
  permitted: ((namespace: string) => boolean) | null
  selected: Set<string> | null
}

export async function resolveViewer(selectedNamespaces: string[] | null): Promise<Viewer | Response> {
  const permitted = await readScope()
  if (permitted instanceof Response) return permitted
  return {
    permitted,
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
