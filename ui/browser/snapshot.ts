import type { Report } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

export type DashboardSnapshot = {
  revision: string
  clusterContext: string
  observedAt: string
  imageUsages: Report["report"]["imageUsages"]
  releaseGroups: Report["report"]["releaseGroupMap"]
  workloadGroups: Report["report"]["workloadGroupMap"]
  workloads: NonNullable<Report["workloads"]>
  drift: Report["rotenness"]
  issues: Report["issues"]
  resources: ClusterResource[]
  warnings?: string[]
  // Components the cluster lacks, such as nodestatd.
  missingComponents?: string[]
  subscriptionUri?: string
  // Prometheus's public address for links from metric charts.
  prometheusUrl?: string | null
}

// Adapt live inventory for existing presentation components. No report is
// stored, selected, or fetched; history comes from Prometheus independently.
export function presentationData(snapshot: DashboardSnapshot): Report {
  if (!snapshot.drift || !Array.isArray(snapshot.imageUsages)) {
    throw new Error("The MCP endpoint returned an incompatible dashboard snapshot")
  }
  return {
    id: "", sourceType: "cluster", clusterContext: snapshot.clusterContext,
    createdAt: snapshot.observedAt, updatedAt: null, status: "ready",
    reportHash: snapshot.revision, previousReportId: null,
    report: { imageUsages: snapshot.imageUsages, workloadGroupMap: snapshot.workloadGroups,
      releaseGroupMap: snapshot.releaseGroups ?? {}, excludedContainerCount: 0 },
    rotenness: snapshot.drift, issues: snapshot.issues, workloads: snapshot.workloads,
  }
}
