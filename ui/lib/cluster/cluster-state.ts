import { create } from "zustand"
import type { AnalysisProgress } from "./refresh-state"
import type { Report } from "./reports"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import type { ClusterNodesResponse } from "@/lib/cluster-resources/types"
import type { AlertGroup } from "@/lib/features/prometheus/types"
import type { ClusterMetrics } from "@/lib/features/prometheus/metrics"
import type { NodeStorageMap } from "@/lib/features/prometheus/node-storage"
import type { LivePatchUpgradeListResponse } from "@/lib/features/live-patch-upgrade/types"

export type PodContainerStatus = {
  name: string
  image: string
  init: boolean
  ready: boolean
  restartCount: number
  waiting: { reason: string; message: string | null } | null
  lastTerminated: { exitCode: number; reason: string; finishedAt: string | null } | null
}

export type PodStatus = {
  display: string
  ready: boolean
  restarts: number
  message: string | null
  containers: PodContainerStatus[]
}

export type LivenessProbe = { container: string; check: string }

export type ClusterResource = {
  uid: string
  kind: string
  name: string
  namespace: string
  createdAt?: string
  labels?: Record<string, string>
  ownerUID?: string
  managerUID?: string
  argoApp?: { name: string; url?: string; detailsUrl?: string; kind?: string; resourceRef?: string }
  ips?: string[]
  declaredPorts?: { container: string; name?: string; port: number; protocol: string }[]
  livenessProbes?: LivenessProbe[]
  hostNetwork?: boolean
  nodeName?: string
  phase?: string
  podStatus?: PodStatus
}

export type ClusterState = {
  clusterName: string | null
  data: Report | null
  reportId: string | null
  isLoading: boolean
  isFetchingReport: boolean
  isConnected: boolean
  connectionError: string | null
  error: string | null
  errorSource: "analysis" | "report" | null
  lastRefreshed: Date | null
  analysis: AnalysisProgress | null
  clusterResources: ClusterResource[] | null
  clusterResourcesError: string | null
  livePatchUpgrades: LivePatchUpgradeListResponse | null
  nodeDrift: ClusterNodesResponse | null
  nodeDriftError: string | null
  vulnerabilityReports: Record<string, VulnerabilityReport> | null
  vulnerabilityReportsError: string | null
  prometheusAlerts: AlertGroup[] | null
  prometheusUrl: string | null
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
  connectionError: null,
  error: null,
  errorSource: null,
  lastRefreshed: null,
  analysis: null,
  clusterResources: null,
  clusterResourcesError: null,
  livePatchUpgrades: null,
  nodeDrift: null,
  nodeDriftError: null,
  vulnerabilityReports: null,
  vulnerabilityReportsError: null,
  prometheusAlerts: null,
  prometheusUrl: null,
  clusterMetrics: null,
  nodeStorage: null,
}))
