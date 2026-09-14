import type { ScopeNotice } from './tenancy.js'

export const ACTIONABLE_VERSION_STATUSES = ['major_behind', 'minor_behind', 'patch_behind', 'behind'] as const

export type ActionableVersionStatus = (typeof ACTIONABLE_VERSION_STATUSES)[number]

export const IMAGE_UPDATE_ACTION_TYPES = ['helm_chart_update', 'image_tag_update', 'manual_review'] as const

export type ImageUpdateActionType = (typeof IMAGE_UPDATE_ACTION_TYPES)[number]

export const MANUAL_REVIEW_REASONS = ['missing_chart_candidate', 'chart_candidate_not_distinct'] as const

export type ManualReviewReason = (typeof MANUAL_REVIEW_REASONS)[number]

export const VERSION_STATUS_RISK_RANK: Record<ActionableVersionStatus, number> = {
  major_behind: 0,
  minor_behind: 1,
  patch_behind: 2,
  behind: 3
}

export interface ImageUpdateFilters {
  namespace: string | null
  versionStatuses: ActionableVersionStatus[]
}

export interface ImageUpdateSnapshot {
  reportId: string
  createdAt: string
}

export interface ImageReference {
  reference: string
  registry: string
  repository: string
  tag: string | null
}

export interface WorkloadIdentity {
  groupKey: string
  kind: string | null
  namespace: string | null
  name: string | null
}

export interface ImageUpdateEvidence {
  workload: WorkloadIdentity
  containerName: string | null
  currentImage: ImageReference
  proposedImage: ImageReference
  versionStatus: ActionableVersionStatus
}

export interface ImageTagUpdateAction {
  actionId: string
  type: 'image_tag_update'
  versionStatus: ActionableVersionStatus
  workload: WorkloadIdentity
  containerName: string | null
  currentImage: ImageReference
  proposedImage: ImageReference
}

export interface HelmChartUpdateAction {
  actionId: string
  type: 'helm_chart_update'
  versionStatus: ActionableVersionStatus
  releaseGroupKey: string
  releaseName: string | null
  releaseNamespace: string | null
  chartName: string | null
  observedChartVersion: string
  latestKnownChartVersion: string
  imageEvidence: ImageUpdateEvidence[]
  totalImageCandidates: number
  omittedImageCandidates: number
}

export interface ManualReviewAction {
  actionId: string
  type: 'manual_review'
  versionStatus: ActionableVersionStatus
  reason: ManualReviewReason
  releaseGroupKey: string
  releaseName: string | null
  releaseNamespace: string | null
  chartName: string | null
  observedChartVersion: string | null
  latestKnownChartVersion: string | null
  imageEvidence: ImageUpdateEvidence[]
  totalImageCandidates: number
  omittedImageCandidates: number
}

export type ImageUpdateAction = ImageTagUpdateAction | HelmChartUpdateAction | ManualReviewAction

export interface ImageUpdatePlanSummary {
  uniqueImageCandidates: number
  totalActions: number
  imageTagUpdates: number
  helmChartUpdates: number
  manualReviews: number
}

interface ImageUpdatePlanResultBase {
  filters: ImageUpdateFilters
  summary: ImageUpdatePlanSummary
  actions: ImageUpdateAction[]
  nextCursor: string | null
  warnings: string[]
  // Whether the caller's tenancy limited what this plan could contain. Always
  // present so an empty plan is never ambiguous between "nothing is behind" and
  // "you may not see it".
  scope: ScopeNotice
}

export interface ImageUpdatePlanResult extends ImageUpdatePlanResultBase {
  status: 'ok'
  snapshot: ImageUpdateSnapshot
}

export interface NoReadyReportResult extends ImageUpdatePlanResultBase {
  status: 'no_ready_report'
  snapshot: null
}

export type PlanImageUpdatesResult = ImageUpdatePlanResult | NoReadyReportResult

export interface ImageUpdateActionSortKey {
  riskRank: number
  actionType: ImageUpdateActionType
  namespace: string
  groupKey: string
}
