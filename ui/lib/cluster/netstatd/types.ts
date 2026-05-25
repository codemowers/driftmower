export type Protocol = "TCP" | "UDP"

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

export type HostInfoEvent = {
  type: "host.info"
  timestamp: string
  nodeName?: string
  hostIPs: string[]
  hostNetNS: number
}

export type NetstatdEvent =
  | ConnectionEvent
  | PortListeningEvent
  | ProcessMetainfoEvent
  | ContainerEvent
  | HostInfoEvent

export type Connection = {
  sockCookie: string
  protocol: Protocol
  state: ConnState
  nodeName?: string
  localIP: string
  remoteIP: string
  localPort?: number
  remotePort?: number
  pid?: number
  inbound: boolean
  firstSeen: number
  lastSeen: number
  aggKey?: string
}

export type ListeningPort = {
  key: string
  protocol: Protocol
  ip: string
  port: number
  nodeName?: string
  netns: number
  isHostNetNS: boolean
  containerUid?: string
}

export type ContainerInfo = {
  containerUid: string
  podUid?: string
  podName?: string
  namespace?: string
  containerName?: string
  image?: string
  nodeName?: string
}

export type ProcessInfo = {
  key: string
  pid: number
  nodeName: string
  netns: number
  isHostNetNS: boolean
  cgroupSlice: string
  containerUid?: string
  exe?: string
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
  port: number
  protocol: Protocol
  count: number
  firstSeen: number
  lastSeen: number
  localIPs: Set<string>
}

export type NetstatdStatus = "idle" | "connecting" | "open" | "closed" | "error"

export type NetstatdState = {
  status: NetstatdStatus
  error: string | null
  rawEventCount: number
  lastFlushedAt: number | null
  revision: number

  connections: Map<string, Connection>
  aggregates: Map<string, AggregateBucket>
  cookieToAgg: Map<string, string>
  listening: Map<string, ListeningPort>
  containersByUid: Map<string, ContainerInfo>
  processes: Map<string, ProcessInfo>
  pidBySockCookie: Map<string, number>
  hosts: Map<string, HostInfo>
}
