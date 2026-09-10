import "server-only"

import type { ConnDelta, ListeningPort } from "../types"
import type { Viewer } from "./authorize"

export type Subscriber = {
  scope: { podUids: Set<string>; podIPs: Set<string> }
  viewer: Viewer
  conns: Map<string, ConnDelta>
  listeningAdded: Map<string, ListeningPort>
  listeningRemoved: Set<string>
  write: (event: string, payload: unknown) => void
  dropped: number
  closed: boolean
}

export function encodeFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}
