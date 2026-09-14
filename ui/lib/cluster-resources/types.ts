export type Readiness = "Ready" | "NotReady" | "Unknown"

export type SupportSeverity = "ok" | "ending" | "urgent" | "extended" | "eol" | "unknown"

export type NodeSupport = {
  severity: SupportSeverity
  label: string
  relative: string
}

export type NodePressure = {
  memory: boolean
  disk: boolean
  pid: boolean
}

export type NodeDrift = {
  name: string
  role: string
  readiness: Readiness
  schedulable: boolean
  pressure: NodePressure
  version: string
  creationTimestamp: string | null
  support: NodeSupport
}

export type PodEvent = {
  type: string
  reason: string
  count: number
  firstSeen: string | null
  lastSeen: string | null
  message: string
}

export type K8sReference = {
  stable: string
  latest: string
}

export type ClusterNodesResponse = {
  nodes: NodeDrift[]
  reference: K8sReference | null
  provider: string
  eolProduct: string
  error?: string
}
