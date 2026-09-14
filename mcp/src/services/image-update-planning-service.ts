import { createHash } from 'node:crypto'
import type {
  DirectImageUpdateActionGroup,
  HelmImageUpdateActionGroup,
  ImageUpdateActionDetailRow,
  ImageUpdateActionGroup,
  ImageUpdateRepository,
  ImageUpdateRepositoryFilters
} from '../backend/image-update-repository.js'
import type { ReportSnapshot, ReportSnapshotRepository } from '../backend/report-snapshot-repository.js'
import {
  ACTIONABLE_VERSION_STATUSES,
  VERSION_STATUS_RISK_RANK,
  type ActionableVersionStatus,
  type ImageReference,
  type ImageTagUpdateAction,
  type ImageUpdateAction,
  type ImageUpdateEvidence,
  type ImageUpdateFilters,
  type ImageUpdatePlanSummary,
  type ManualReviewAction,
  type PlanImageUpdatesResult,
  type WorkloadIdentity
} from '../domain/image-update-plan.js'
import { parseReleaseInfo } from '../domain/release-info.js'
import {
  decodeImageUpdateCursor,
  encodeImageUpdateCursor,
  type ImageUpdateCursorPayload
} from './image-update-cursor.js'

const PAGE_LOOKAHEAD = 1
const MAX_HELM_IMAGE_EVIDENCE = 10
const SNAPSHOT_WARNING = 'This plan is based on a Driftmower analysis snapshot, not live cluster state.'
const ADVISORY_WARNING =
  'Proposed updates are advisory and do not confirm compatibility, maintenance approval, or deployment safety.'
const PLAN_WARNINGS = [SNAPSHOT_WARNING, ADVISORY_WARNING]
const ACTIONABLE_STATUS_SET = new Set<string>(ACTIONABLE_VERSION_STATUSES)

export interface PlanImageUpdatesInput {
  namespace?: string
  versionStatuses?: ActionableVersionStatus[]
  limit?: number
  cursor?: string
}

interface NormalizedPlanningRequest {
  filters: ImageUpdateFilters
  limit: number
  cursor: ImageUpdateCursorPayload | null
}

interface VersionCandidate {
  raw: string
  normalized: string
}

export class ImageUpdatePlanningService {
  constructor(
    private readonly repository: ImageUpdateRepository,
    private readonly reportSnapshotRepository: ReportSnapshotRepository,
    private readonly defaultLimit: number,
    private readonly maximumLimit: number
  ) {}

  async planImageUpdates(input: PlanImageUpdatesInput): Promise<PlanImageUpdatesResult> {
    const request = normalizeRequest(input, this.defaultLimit, this.maximumLimit)
    const snapshot = await resolveSnapshot(this.reportSnapshotRepository, request)

    if (snapshot === null) {
      return noReadyReportResult(request.filters)
    }

    const repositoryFilters = filtersForSnapshot(snapshot, request.filters)
    const groups = await this.repository.listActionGroups({
      ...repositoryFilters,
      after: request.cursor?.lastAction ?? null,
      limit: request.limit + PAGE_LOOKAHEAD
    })
    const pageGroups = groups.slice(0, request.limit)
    const [details, summary] = await Promise.all([
      this.repository.loadActionDetails({ ...repositoryFilters, groups: pageGroups }),
      this.repository.summarizeActions(repositoryFilters)
    ])

    return buildPlanResult(snapshot, request, pageGroups, details, summary, groups.length > request.limit)
  }
}

function normalizeRequest(
  input: PlanImageUpdatesInput,
  defaultLimit: number,
  maximumLimit: number
): NormalizedPlanningRequest {
  const filters: ImageUpdateFilters = {
    namespace: optionalNamespace(input.namespace),
    versionStatuses: normalizeVersionStatuses(input.versionStatuses)
  }
  const cursor = input.cursor ? decodeImageUpdateCursor(input.cursor, filters) : null

  return {
    filters,
    limit: normalizeLimit(input.limit, defaultLimit, maximumLimit),
    cursor
  }
}

async function resolveSnapshot(
  repository: ReportSnapshotRepository,
  request: NormalizedPlanningRequest
): Promise<ReportSnapshot | null> {
  if (request.cursor) {
    const snapshot = await repository.findReadyInClusterReportById(request.cursor.reportId)

    if (snapshot === null) {
      throw new Error('cursor report is no longer an eligible ready snapshot')
    }

    return snapshot
  }

  return repository.findLatestReadyInClusterReport()
}

function buildPlanResult(
  snapshot: ReportSnapshot,
  request: NormalizedPlanningRequest,
  groups: ImageUpdateActionGroup[],
  details: ImageUpdateActionDetailRow[],
  summary: ImageUpdatePlanSummary,
  hasMore: boolean
): PlanImageUpdatesResult {
  const detailsByGroup = groupDetails(details)
  const actions = groups.map(group =>
    mapAction(snapshot.reportId, group, detailsByGroup.get(group.groupKey) ?? [])
  )
  const lastGroup = groups.at(-1)
  const nextCursor =
    hasMore && lastGroup ? encodeNextCursor(snapshot.reportId, request.filters, lastGroup) : null

  return {
    status: 'ok',
    filters: request.filters,
    snapshot: { reportId: snapshot.reportId, createdAt: snapshot.createdAt },
    summary,
    actions,
    nextCursor,
    warnings: [...PLAN_WARNINGS]
  }
}

function noReadyReportResult(filters: ImageUpdateFilters): PlanImageUpdatesResult {
  return {
    status: 'no_ready_report',
    filters,
    snapshot: null,
    summary: emptySummary(),
    actions: [],
    nextCursor: null,
    warnings: [...PLAN_WARNINGS]
  }
}

function mapAction(
  reportId: string,
  group: ImageUpdateActionGroup,
  details: ImageUpdateActionDetailRow[]
): ImageUpdateAction {
  if (group.actionType === 'image_tag_update') {
    return mapDirectAction(reportId, group)
  }

  return mapHelmAction(reportId, group, details)
}

function mapDirectAction(reportId: string, group: DirectImageUpdateActionGroup): ImageTagUpdateAction {
  return {
    actionId: actionId(reportId, group),
    type: 'image_tag_update',
    versionStatus: group.versionStatus,
    workload: workloadIdentity(group),
    containerName: group.containerName,
    currentImage: imageReference(group.registry, group.repository, group.deployedTag),
    proposedImage: imageReference(group.registry, group.repository, group.latestTag)
  }
}

function mapHelmAction(
  reportId: string,
  group: HelmImageUpdateActionGroup,
  details: ImageUpdateActionDetailRow[]
): ImageUpdateAction {
  const releaseInfo =
    details.map(detail => parseReleaseInfo(detail.releaseInfo)).find(info => info !== null) ?? null
  const observedVersion = versionCandidate(releaseInfo?.chartVersion)
  const latestVersion = versionCandidate(releaseInfo?.latestChartTag)
  const common = commonHelmActionFields(reportId, group, details, releaseInfo)

  if (group.actionType === 'helm_chart_update') {
    return helmChartUpdateAction(common, observedVersion, latestVersion)
  }

  return manualReviewAction(common, observedVersion, latestVersion)
}

function commonHelmActionFields(
  reportId: string,
  group: HelmImageUpdateActionGroup,
  details: ImageUpdateActionDetailRow[],
  releaseInfo: ReturnType<typeof parseReleaseInfo>
): Omit<ManualReviewAction, 'type' | 'reason' | 'observedChartVersion' | 'latestKnownChartVersion'> {
  const evidence = uniqueEvidence(details)

  return {
    actionId: actionId(reportId, group),
    versionStatus: group.versionStatus,
    releaseGroupKey: group.releaseGroupKey,
    releaseName: releaseInfo?.name ?? null,
    releaseNamespace: releaseInfo?.namespace ?? null,
    chartName: releaseInfo?.chartName ?? null,
    imageEvidence: evidence.slice(0, MAX_HELM_IMAGE_EVIDENCE),
    totalImageCandidates: evidence.length,
    omittedImageCandidates: Math.max(0, evidence.length - MAX_HELM_IMAGE_EVIDENCE)
  }
}

function helmChartUpdateAction(
  common: Omit<ManualReviewAction, 'type' | 'reason' | 'observedChartVersion' | 'latestKnownChartVersion'>,
  observedVersion: VersionCandidate | null,
  latestVersion: VersionCandidate | null
): ImageUpdateAction {
  if (observedVersion === null || latestVersion === null) {
    throw new Error('Helm chart update group is missing a usable chart version candidate')
  }

  return {
    ...common,
    type: 'helm_chart_update',
    observedChartVersion: observedVersion.raw,
    latestKnownChartVersion: latestVersion.raw
  }
}

function manualReviewAction(
  common: Omit<ManualReviewAction, 'type' | 'reason' | 'observedChartVersion' | 'latestKnownChartVersion'>,
  observedVersion: VersionCandidate | null,
  latestVersion: VersionCandidate | null
): ManualReviewAction {
  const reason = observedVersion && latestVersion ? 'chart_candidate_not_distinct' : 'missing_chart_candidate'

  return {
    ...common,
    type: 'manual_review',
    reason,
    observedChartVersion: observedVersion?.raw ?? null,
    latestKnownChartVersion: latestVersion?.raw ?? null
  }
}

function groupDetails(rows: ImageUpdateActionDetailRow[]): Map<string, ImageUpdateActionDetailRow[]> {
  const detailsByGroup = new Map<string, ImageUpdateActionDetailRow[]>()

  for (const row of rows) {
    const key = detailGroupKey(row)
    const groupRows = detailsByGroup.get(key) ?? []

    groupRows.push(row)
    detailsByGroup.set(key, groupRows)
  }

  return detailsByGroup
}

function uniqueEvidence(rows: ImageUpdateActionDetailRow[]): ImageUpdateEvidence[] {
  const evidenceByIdentity = new Map<string, ImageUpdateEvidence>()

  for (const row of rows) {
    const evidence = evidenceFromRow(row)
    const key = detailDirectGroupKey(row)
    const existing = evidenceByIdentity.get(key)

    if (!existing || isHigherRisk(evidence.versionStatus, existing.versionStatus)) {
      evidenceByIdentity.set(key, evidence)
    }
  }

  return [...evidenceByIdentity.values()].sort(compareEvidence)
}

function evidenceFromRow(row: ImageUpdateActionDetailRow): ImageUpdateEvidence {
  return {
    workload: workloadIdentity(row),
    containerName: row.containerName,
    currentImage: imageReference(row.registry, row.repository, row.deployedTag),
    proposedImage: imageReference(row.registry, row.repository, row.latestTag),
    versionStatus: row.versionStatus
  }
}

function workloadIdentity(
  value: Pick<
    ImageUpdateActionDetailRow,
    'workloadGroupKey' | 'workloadKind' | 'workloadNamespace' | 'workloadName'
  >
): WorkloadIdentity {
  return {
    groupKey: value.workloadGroupKey,
    kind: value.workloadKind,
    namespace: value.workloadNamespace,
    name: value.workloadName
  }
}

function imageReference(registry: string, repository: string, tag: string | null): ImageReference {
  const repositoryReference = `${registry}/${repository}`

  return {
    reference: tag ? `${repositoryReference}:${tag}` : repositoryReference,
    registry,
    repository,
    tag
  }
}

function versionCandidate(value: string | undefined): VersionCandidate | null {
  const raw = value?.trim() ?? ''
  const normalized = raw.startsWith('v') ? raw.slice(1) : raw

  if (!raw || !normalized) {
    return null
  }

  return { raw, normalized }
}

function detailGroupKey(row: ImageUpdateActionDetailRow): string {
  return row.releaseGroupKey ?? detailDirectGroupKey(row)
}

function detailDirectGroupKey(row: ImageUpdateActionDetailRow): string {
  return JSON.stringify([
    row.workloadGroupKey,
    row.containerName,
    row.registry,
    row.repository,
    row.deployedTag,
    row.latestTag
  ])
}

function encodeNextCursor(
  reportId: string,
  filters: ImageUpdateFilters,
  group: ImageUpdateActionGroup
): string {
  return encodeImageUpdateCursor(reportId, filters, {
    riskRank: group.riskRank,
    actionType: group.actionType,
    namespace: group.namespace,
    groupKey: group.groupKey
  })
}

function filtersForSnapshot(
  snapshot: ReportSnapshot,
  filters: ImageUpdateFilters
): ImageUpdateRepositoryFilters {
  return {
    reportId: snapshot.reportId,
    namespace: filters.namespace,
    versionStatuses: filters.versionStatuses
  }
}

function normalizeVersionStatuses(
  statuses: ActionableVersionStatus[] | undefined
): ActionableVersionStatus[] {
  const requestedStatuses: string[] = statuses ?? [...ACTIONABLE_VERSION_STATUSES]
  const uniqueStatuses = new Set(requestedStatuses)

  if (requestedStatuses.length === 0 || uniqueStatuses.size !== requestedStatuses.length) {
    throw new Error('versionStatuses must contain one or more unique actionable statuses')
  }

  if (requestedStatuses.some(status => !ACTIONABLE_STATUS_SET.has(status))) {
    throw new Error(`versionStatuses must use: ${ACTIONABLE_VERSION_STATUSES.join(', ')}`)
  }

  return ACTIONABLE_VERSION_STATUSES.filter(status => uniqueStatuses.has(status))
}

function normalizeLimit(limit: number | undefined, defaultLimit: number, maximumLimit: number): number {
  const requestedLimit = limit ?? defaultLimit

  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('limit must be a positive integer')
  }

  return Math.min(requestedLimit, maximumLimit)
}

function requiredText(value: string, name: string): string {
  const normalizedValue = value.trim()

  if (!normalizedValue) {
    throw new Error(`${name} must be a non-empty string`)
  }

  return normalizedValue
}

function optionalNamespace(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }

  return requiredText(value, 'namespace')
}

function actionId(reportId: string, group: ImageUpdateActionGroup): string {
  const identity = JSON.stringify([reportId, group.actionType, group.namespace, group.groupKey])

  return createHash('sha256').update(identity).digest('hex')
}

function isHigherRisk(left: ActionableVersionStatus, right: ActionableVersionStatus): boolean {
  return VERSION_STATUS_RISK_RANK[left] < VERSION_STATUS_RISK_RANK[right]
}

function compareEvidence(left: ImageUpdateEvidence, right: ImageUpdateEvidence): number {
  return (
    (left.workload.namespace ?? '').localeCompare(right.workload.namespace ?? '') ||
    left.workload.groupKey.localeCompare(right.workload.groupKey) ||
    (left.containerName ?? '').localeCompare(right.containerName ?? '') ||
    left.currentImage.reference.localeCompare(right.currentImage.reference) ||
    left.proposedImage.reference.localeCompare(right.proposedImage.reference)
  )
}

function emptySummary(): ImageUpdatePlanSummary {
  return {
    uniqueImageCandidates: 0,
    totalActions: 0,
    imageTagUpdates: 0,
    helmChartUpdates: 0,
    manualReviews: 0
  }
}
