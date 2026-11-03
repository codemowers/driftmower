import "server-only"

import type { Protocol } from "../types"

export type ConnState =
  | "ESTABLISHED" | "SYN_SENT" | "SYN_RECV" | "FIN_WAIT1" | "FIN_WAIT2"
  | "TIME_WAIT" | "CLOSE" | "CLOSE_WAIT" | "LAST_ACK" | "LISTEN" | "CLOSING"

export type ConnectionEvent = {
  type: "connection.event" | "connection.accepted"
  timestamp: string
  nodeName?: string
  protocol: Protocol
  state: ConnState
  sockCookie: string | number
  localIP: string
  remoteIP: string
  localPort?: number
  remotePort?: number
  pid?: number
}

export type PortListeningEvent = {
  type: "port.listening"
  timestamp: string
  nodeName?: string
  protocol: Protocol
  ip: string
  port: number
  netns: number
  isHostNetNS: boolean
}

export type ProcessMetainfoEvent = {
  type: "process.metainfo"
  timestamp: string
  nodeName: string
  pid: number
  exe?: string
  netns: number
  isHostNetNS: boolean
  cgroupSlice: string
  containerUid?: string
}

export type ContainerEvent = {
  type: "container.added" | "container.metainfo"
  timestamp: string
  nodeName?: string
  containerUid: string
  name?: string
  podName?: string
  namespace?: string
  podUid?: string
  containerName?: string
  image?: string
  labels?: Record<string, string>
}

export type ContainerDeletedEvent = {
  type: "container.deleted"
  timestamp?: string
  nodeName?: string
  containerUid: string
}

export type HostInfoEvent = {
  type: "host.info"
  timestamp: string
  nodeName?: string
  hostIPs: string[]
  hostNetNS: number
}

export type UpstreamEvent =
  | ConnectionEvent
  | PortListeningEvent
  | ProcessMetainfoEvent
  | ContainerEvent
  | ContainerDeletedEvent
  | HostInfoEvent

export function parseUpstream(raw: string): UpstreamEvent | null {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.type === "string" ? (parsed as UpstreamEvent) : null
  } catch {
    return null
  }
}
