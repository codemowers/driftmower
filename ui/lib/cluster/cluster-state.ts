import { create } from "zustand"
import type { AnalyzeClusterProgress } from "./refresh-state"
import type { Report } from "./reports"
import type { VulnerabilityReport } from "./vulnerability/types"
import type { ClusterNodesResponse } from "@/lib/api/cluster-resources/types"
import type { AlertsResult } from "./prometheus/alerts"
import type { ClusterMetrics } from "./prometheus/metrics"
import type { NodeStorageMap } from "./prometheus/node-storage"

export type ClusterResource = {
  uid: string
  kind: string
  apiGroup: string
  name: string
  namespace: string
  labels?: Record<string, string>
  ownerUID?: string
  managerUID?: string
  argoApp?: { name: string; url?: string; kind?: string; resourceRef?: string }
  ips?: string[]
  declaredPorts?: { container: string; name?: string; port: number; protocol: string }[]
  nodeName?: string
  phase?: string
  podStatus?: { display: string; ready: boolean; restarts: number }
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
  clusterResources: ClusterResource[] | null
  nodeDrift: ClusterNodesResponse | null
  vulnerabilityReports: Record<string, VulnerabilityReport> | null
  vulnerabilityReportsError: boolean
  prometheusAlerts: AlertsResult | null
  clusterMetrics: ClusterMetrics | null
  nodeStorage: NodeStorageMap | null
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
  clusterResources: null,
  nodeDrift: null,
  vulnerabilityReports: null,
  vulnerabilityReportsError: false,
  prometheusAlerts: null,
  clusterMetrics: null,
  nodeStorage: null,
}))
