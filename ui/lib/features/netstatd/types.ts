export type Protocol = "TCP" | "UDP"

export type PeerClass = "workload" | "service" | "node" | "external" | "unknown"

export type PeerRef = {
  class: PeerClass
  ownerKind?: string
  namespace?: string
  name?: string
  nodeName?: string
  restricted?: true
}

export type ListeningPort = {
  key: string
  protocol: Protocol
  ip: string
  port: number
  nodeName?: string
  netns: number
  isHostNetNS: boolean
  ownerPodUid?: string
}

export type HostInfo = {
  nodeName: string
  hostIPs: Set<string>
  hostNetNS: number
}

export type AggregateDirection = "inbound" | "outbound"

export type AggregateBucket = {
  key: string
  direction: AggregateDirection
  peerIP: string
  peer: PeerRef
  port: number
  protocol: Protocol
  count: number
  firstSeen: number
  lastSeen: number
  localIPs: Set<string>
}

export type NetstatdStatus = "idle" | "connecting" | "open" | "closed" | "error"

export type UpstreamHealth = {
  total: number
  connected: number
}

export type ConnDelta = {
  key: string
  direction: AggregateDirection
  localIP: string
  peerIP: string
  peer: PeerRef
  port: number
  protocol: Protocol
  count: number
  lastSeen: number
}

export type HostWire = {
  nodeName: string
  hostIPs: string[]
  hostNetNS: number
}

export type NetstatdState = {
  status: NetstatdStatus
  error: string | null
  lastFlushedAt: number | null

  aggregates: Map<string, AggregateBucket>
  listening: Map<string, ListeningPort>
  hosts: Map<string, HostInfo>
  hiddenCount: number
  upstream: UpstreamHealth | null
}
