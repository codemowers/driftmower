import type { ScopeNotice } from './tenancy.js'

export interface SearchWorkloadsResult {
  query: string
  matches: WorkloadMatch[]
  // Whether the caller's tenancy limited these matches. Always present so an
  // empty result is never ambiguous between "no such workload" and "not yours
  // to see".
  scope: ScopeNotice
}

export interface WorkloadMatch {
  workloadId: string
  name: string | null
  kind: string | null
  cluster: string | null
  namespace: string | null
  analysis: WorkloadAnalysis
  snapshot: SnapshotInfo
}

export interface WorkloadAnalysis {
  status: string | null
  helm: HelmAnalysis | null
  images: ImageAnalysis[]
}

export interface HelmAnalysis {
  releaseName: string | null
  releaseNamespace: string | null
  chartName: string | null
  observedChartVersion: string | null
  latestKnownChartVersion: string | null
  appVersion: string | null
}

export interface ImageAnalysis {
  registry: string
  repository: string
  observedTag: string | null
  latestKnownTag: string | null
  status: string | null
  versionStatus: string | null
}

export interface SnapshotInfo {
  reportId: string
  createdAt: string
}
