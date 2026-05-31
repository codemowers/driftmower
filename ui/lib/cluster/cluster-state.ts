import { create } from "zustand"
import type { AnalyzeClusterProgress } from "./refresh-state"
import type { Report } from "./reports"
import type { VulnerabilityReport } from "./vulnerability/types"

export type ExplorerResource = {
  type: string
  uid: string
  kind: string
  apiGroup: string
  name: string
  namespace: string
  labels?: Record<string, string>
  ownerUID?: string
  managerUID?: string
  ips?: string[]
  nodeName?: string
  phase?: string
  images?: { name: string; normalized: string; digest: string }[]
}

export type ClusterState = {
  clusterName: string | null
  data: Report | null
  reportId: string | null
  isLoading: boolean
  isFetchingReport: boolean
  isConnected: boolean
  error: string | null
  lastRefreshed: Date | null
  socketProgress: AnalyzeClusterProgress | null
  containerCount: number | null
  explorerResources: ExplorerResource[] | null
  vulnerabilityReports: Record<string, VulnerabilityReport> | null
  vulnerabilityReportsError: boolean
}

export const useClusterState = create<ClusterState>(() => ({
  clusterName: null,
  data: null,
  reportId: null,
  isLoading: false,
  isFetchingReport: false,
  isConnected: false,
  error: null,
  lastRefreshed: null,
  socketProgress: null,
  containerCount: null,
  explorerResources: null,
  vulnerabilityReports: null,
  vulnerabilityReportsError: false,
}))
