export type Readiness = "Ready" | "NotReady" | "Unknown"

export type SupportSeverity = "ok" | "ending" | "urgent" | "extended" | "eol" | "unknown"

export type NodeSupport = {
  severity: SupportSeverity
  label: string
  relative: string
}

export type NodeDrift = {
  name: string
  role: string
  readiness: Readiness
  schedulable: boolean
  version: string
  creationTimestamp: string | null
  support: NodeSupport
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
