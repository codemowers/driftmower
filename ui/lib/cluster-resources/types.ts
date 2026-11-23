export type Readiness = "Ready" | "NotReady" | "Unknown"

export type NodePressure = {
  memory: boolean
  disk: boolean
  pid: boolean
}

// One Node as list_nodes reports it, with its roles joined for grouping.
export type NodeDrift = {
  memory?: {used:number;total:number;graph?:string[]} | null
  name: string
  role: string
  readiness: Readiness
  conditions?: string[]
  schedulable: boolean
  pressure: NodePressure
  version: string
  osImage: string
  kernelVersion: string
  containerRuntime: string
  architecture: string
  creationTimestamp: string | null
  bootTime?: string | null
}

export type ClusterNodesResponse = {
  nodes: NodeDrift[]
}
