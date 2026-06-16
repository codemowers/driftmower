import type { StatusType } from "@/lib/cluster/reports"

export type Readiness = "Ready" | "NotReady" | "Unknown"

export type NodeDrift = {
  name: string
  role: string
  readiness: Readiness
  schedulable: boolean
  version: string
  creationTimestamp: string | null
  statusType: StatusType
  target: string | null
}

export type K8sReference = {
  stable: string
  latest: string
}

export type ClusterNodesResponse = {
  nodes: NodeDrift[]
  reference: K8sReference | null
  error?: string
}
