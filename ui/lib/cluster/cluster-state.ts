import type { PodSpread } from "./availability"
import { create } from "zustand"
import type { Report } from "./reports"
import type { PodSecurity } from "./pod-security"
import type { Subject } from "@/lib/features/users/types"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import type { ClusterNodesResponse } from "@/lib/cluster-resources/types"
import type { ClusterMetrics } from "@/lib/features/prometheus/metrics"
import type { NodeStorageMap } from "@/lib/features/prometheus/node-storage"

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
  scanPod?: boolean
  issues?: import("@/lib/cluster/issues").WorkloadIssue[]
  uid: string
  kind: string
  apiVersion?: string
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
  restartedAt?: string
  hostNetwork?: boolean
  nodeName?: string
  jobOwned?: boolean
  terminating?: boolean
  phase?: string
  podStatus?: PodStatus
  priorityClassName?: string
  priority?: number
  security?: PodSecurity
  spread?: PodSpread[]
  // Top-level owners: provenance labels and annotations by key, and the
  // account named by codemowers.io/created-by.
  provenance?: Record<string, string>
  createdBy?: Subject
  // The latest write other than to status, and its field manager.
  updatedAt?: string
  updatedBy?: string
  // A custom-resource owner known only from a reference; its times are read
  // with get_owner_record.
  ownerReferenceOnly?: boolean
}

export type ClusterState = {
  imageScanStatuses: Record<string,string>
  // Latest failure reason of an unfinished scan, by digest.
  imageScanFailures: Record<string, string | undefined>
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
  clusterResources: ClusterResource[] | null
  clusterResourcesError: string | null
  nodeDrift: ClusterNodesResponse | null
  nodeDriftError: string | null
  vulnerabilityReports: Record<string, VulnerabilityReport> | null
  vulnerabilityReportsError: string | null
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
  clusterResources: null,
  clusterResourcesError: null,
  nodeDrift: null,
  nodeDriftError: null,
  imageScanStatuses: {},
  imageScanFailures: {},
  vulnerabilityReports: null,
  vulnerabilityReportsError: null,
  prometheusUrl: null,
  clusterMetrics: null,
  nodeStorage: null,
}))
