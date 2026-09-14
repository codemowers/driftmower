import {
  ACTIONABLE_VERSION_STATUSES,
  VERSION_STATUS_RISK_RANK,
  type ActionableVersionStatus,
  type ImageUpdateActionSortKey,
  type ImageUpdateActionType,
  type ImageUpdatePlanSummary
} from '../domain/image-update-plan.js'
import { parseReleaseInfo } from '../domain/release-info.js'
import type { ImageUsageRow, ReportRows, ReportRowLoader } from './report-rows.js'

const IMAGE_TAG_UPDATE_ACTION_TYPE = 'image_tag_update' as const
const HELM_CHART_UPDATE_ACTION_TYPE = 'helm_chart_update' as const
const MANUAL_REVIEW_ACTION_TYPE = 'manual_review' as const

export interface ImageUpdateRepositoryFilters {
  reportId: string
  namespace: string | null
  versionStatuses: ActionableVersionStatus[]
}

export interface ListImageUpdateActionGroupsInput extends ImageUpdateRepositoryFilters {
  after: ImageUpdateActionSortKey | null
  limit: number
}

export interface LoadImageUpdateActionDetailsInput extends ImageUpdateRepositoryFilters {
  groups: ImageUpdateActionGroup[]
}

interface ImageUpdateActionGroupBase extends ImageUpdateActionSortKey {
  reportId: string
  versionStatus: ActionableVersionStatus
}

type ImageUpdateActionGroupCommon = Omit<ImageUpdateActionGroupBase, 'actionType'>

export interface DirectImageUpdateActionGroup extends ImageUpdateActionGroupBase {
  actionType: 'image_tag_update'
  releaseGroupKey: null
  workloadGroupKey: string
  workloadKind: string | null
  workloadNamespace: string | null
  workloadName: string | null
  containerName: string | null
  registry: string
  repository: string
  deployedTag: string | null
  latestTag: string
}

export interface HelmImageUpdateActionGroup extends ImageUpdateActionGroupBase {
  actionType: 'helm_chart_update' | 'manual_review'
  releaseGroupKey: string
  workloadGroupKey: null
  workloadKind: null
  workloadNamespace: null
  workloadName: null
  containerName: null
  registry: null
  repository: null
  deployedTag: null
  latestTag: null
}

export type ImageUpdateActionGroup = DirectImageUpdateActionGroup | HelmImageUpdateActionGroup

export interface ImageUpdateActionDetailRow {
  reportId: string
  workloadGroupKey: string
  workloadKind: string | null
  workloadNamespace: string | null
  workloadName: string | null
  releaseGroupKey: string | null
  containerName: string | null
  registry: string
  repository: string
  deployedTag: string | null
  latestTag: string
  versionStatus: ActionableVersionStatus
  releaseInfo: string | null
}

export interface ImageUpdateRepository {
  listActionGroups(input: ListImageUpdateActionGroupsInput): Promise<ImageUpdateActionGroup[]>
  loadActionDetails(input: LoadImageUpdateActionDetailsInput): Promise<ImageUpdateActionDetailRow[]>
  summarizeActions(input: ImageUpdateRepositoryFilters): Promise<ImageUpdatePlanSummary>
}

// An actionable row: one image usage that is behind and has somewhere to go.
interface ActionableRow extends ImageUsageRow {
  versionStatus: ActionableVersionStatus
  latestTag: string
  releaseInfo: string | null
}

export class BackendImageUpdateRepository implements ImageUpdateRepository {
  constructor(private readonly rowLoader: ReportRowLoader) {}

  async listActionGroups(input: ListImageUpdateActionGroupsInput): Promise<ImageUpdateActionGroup[]> {
    const rows = await this.loadActionableRows(input)
    const groups = [...buildDirectGroups(rows), ...buildHelmGroups(rows)].sort(compareActionGroups)

    return groups.filter(group => isAfterCursor(group, input.after)).slice(0, input.limit)
  }

  async loadActionDetails(
    input: LoadImageUpdateActionDetailsInput
  ): Promise<ImageUpdateActionDetailRow[]> {
    if (input.groups.length === 0) {
      return []
    }

    const rows = await this.loadActionableRows(input)

    return rows
      .filter(row => input.groups.some(group => rowBelongsToGroup(row, group)))
      .sort(compareDetailRows)
      .map(row => ({
        reportId: row.reportId,
        workloadGroupKey: row.workloadGroupKey,
        workloadKind: row.workloadKind,
        workloadNamespace: row.workloadNamespace,
        workloadName: row.workloadName,
        releaseGroupKey: row.releaseGroupKey,
        containerName: row.containerName,
        registry: row.registry,
        repository: row.repository,
        deployedTag: row.deployedTag,
        latestTag: row.latestTag,
        versionStatus: row.versionStatus,
        releaseInfo: row.releaseInfo
      }))
  }

  async summarizeActions(input: ImageUpdateRepositoryFilters): Promise<ImageUpdatePlanSummary> {
    const rows = await this.loadActionableRows(input)
    const helmGroups = buildHelmGroups(rows)
    const imageTagUpdates = buildDirectGroups(rows).length
    const helmChartUpdates = countActionType(helmGroups, HELM_CHART_UPDATE_ACTION_TYPE)
    const manualReviews = countActionType(helmGroups, MANUAL_REVIEW_ACTION_TYPE)

    return {
      // Counted across every actionable row, Helm-managed or not: the same
      // image pinned by two workloads is one candidate, not two.
      uniqueImageCandidates: new Set(rows.map(directGroupKey)).size,
      totalActions: imageTagUpdates + helmChartUpdates + manualReviews,
      imageTagUpdates,
      helmChartUpdates,
      manualReviews
    }
  }

  private async loadActionableRows(filters: ImageUpdateRepositoryFilters): Promise<ActionableRow[]> {
    const rows = await this.rowLoader.load(filters.reportId)

    return rows.imageUsages
      .filter(usage => isActionable(usage, filters))
      .map(usage => ({
        ...(usage as ActionableRow),
        releaseInfo: releaseInfoFor(rows, usage.releaseGroupKey)
      }))
  }
}

// A row is actionable when it is behind by one of the requested statuses and
// names the tag it is behind. Rows without a latest tag have no action to take.
function isActionable(row: ImageUsageRow, filters: ImageUpdateRepositoryFilters): boolean {
  if (row.latestTag === null || row.versionStatus === null) {
    return false
  }

  if (!filters.versionStatuses.includes(row.versionStatus as ActionableVersionStatus)) {
    return false
  }

  return filters.namespace === null || row.workloadNamespace === filters.namespace
}

function releaseInfoFor(rows: ReportRows, releaseGroupKey: string | null): string | null {
  if (releaseGroupKey === null) {
    return null
  }

  return rows.releaseInfoByGroupKey.get(releaseGroupKey) ?? null
}

// Rows outside a Helm release are grouped per image identity, so one action
// covers every replica of the same container running the same tag.
function buildDirectGroups(rows: ActionableRow[]): DirectImageUpdateActionGroup[] {
  const grouped = groupBy(
    rows.filter(row => row.releaseGroupKey === null),
    directGroupKey
  )

  return [...grouped.values()].map(groupRows => {
    const first = groupRows[0]
    const riskRank = minimumRiskRank(groupRows)

    return {
      reportId: first.reportId,
      actionType: IMAGE_TAG_UPDATE_ACTION_TYPE,
      riskRank,
      versionStatus: statusForRiskRank(riskRank),
      namespace: minimumText(groupRows.map(row => row.workloadNamespace)) ?? '',
      groupKey: directGroupKey(first),
      releaseGroupKey: null,
      workloadGroupKey: first.workloadGroupKey,
      workloadKind: minimumText(groupRows.map(row => row.workloadKind)),
      workloadNamespace: minimumText(groupRows.map(row => row.workloadNamespace)),
      workloadName: minimumText(groupRows.map(row => row.workloadName)),
      containerName: first.containerName,
      registry: first.registry,
      repository: first.repository,
      deployedTag: first.deployedTag,
      latestTag: first.latestTag
    }
  })
}

// Helm-managed rows are grouped per release: bumping the chart is one action
// however many images it carries.
function buildHelmGroups(rows: ActionableRow[]): HelmImageUpdateActionGroup[] {
  const grouped = groupBy(
    rows.filter(row => row.releaseGroupKey !== null),
    row => JSON.stringify([row.releaseGroupKey, row.releaseInfo])
  )

  return [...grouped.values()].map(groupRows => {
    const first = groupRows[0]
    const riskRank = minimumRiskRank(groupRows)
    const releaseInfo = parseReleaseInfo(first.releaseInfo)

    return {
      reportId: first.reportId,
      actionType: helmActionType(releaseInfo),
      riskRank,
      versionStatus: statusForRiskRank(riskRank),
      namespace:
        releaseInfo?.namespace ?? minimumText(groupRows.map(row => row.workloadNamespace)) ?? '',
      groupKey: first.releaseGroupKey as string,
      releaseGroupKey: first.releaseGroupKey as string,
      workloadGroupKey: null,
      workloadKind: null,
      workloadNamespace: null,
      workloadName: null,
      containerName: null,
      registry: null,
      repository: null,
      deployedTag: null,
      latestTag: null
    }
  })
}

// A chart update is only proposable when the release names both the version it
// runs and a different version to move to. Anything else is a manual review:
// the fix is not a tag bump this tool can describe.
function helmActionType(
  releaseInfo: ReturnType<typeof parseReleaseInfo>
): HelmImageUpdateActionGroup['actionType'] {
  const observed = normalizeChartVersion(releaseInfo?.chartVersion)
  const latest = normalizeChartVersion(releaseInfo?.latestChartTag)

  if (observed.length === 0 || latest.length === 0 || observed === latest) {
    return MANUAL_REVIEW_ACTION_TYPE
  }

  return HELM_CHART_UPDATE_ACTION_TYPE
}

// Compares `v1.2.3` with `1.2.3` as the same version, matching how chart tags
// are written inconsistently across repositories.
function normalizeChartVersion(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''

  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
}

function directGroupKey(row: ImageUsageRow): string {
  return JSON.stringify([
    row.workloadGroupKey,
    row.containerName,
    row.registry,
    row.repository,
    row.deployedTag,
    row.latestTag
  ])
}

function rowBelongsToGroup(row: ActionableRow, group: ImageUpdateActionGroup): boolean {
  if (group.releaseGroupKey !== null) {
    return row.releaseGroupKey === group.releaseGroupKey
  }

  return row.releaseGroupKey === null && directGroupKey(row) === group.groupKey
}

function minimumRiskRank(rows: ActionableRow[]): number {
  return Math.min(...rows.map(row => VERSION_STATUS_RISK_RANK[row.versionStatus]))
}

// SQL MIN over text: the lowest value, ignoring nulls, null when all are null.
function minimumText(values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => value !== null)

  if (present.length === 0) {
    return null
  }

  return present.reduce((lowest, value) => (value < lowest ? value : lowest))
}

function groupBy<Row>(rows: Row[], toKey: (row: Row) => string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>()

  for (const row of rows) {
    const key = toKey(row)
    const existing = grouped.get(key)

    if (existing) {
      existing.push(row)

      continue
    }

    grouped.set(key, [row])
  }

  return grouped
}

// Riskiest first, and otherwise fully deterministic: the cursor is a position
// in exactly this order, so two calls must agree on it. Plain comparisons keep
// that ordering byte-wise rather than locale-dependent.
function compareActionGroups(left: ImageUpdateActionGroup, right: ImageUpdateActionGroup): number {
  return (
    left.riskRank - right.riskRank ||
    compareText(left.actionType, right.actionType) ||
    compareText(left.namespace, right.namespace) ||
    compareText(left.groupKey, right.groupKey)
  )
}

function isAfterCursor(group: ImageUpdateActionGroup, after: ImageUpdateActionSortKey | null): boolean {
  if (after === null) {
    return true
  }

  return compareActionGroups(group, { ...after } as ImageUpdateActionGroup) > 0
}

function compareDetailRows(left: ActionableRow, right: ActionableRow): number {
  return (
    compareNullableText(left.releaseGroupKey, right.releaseGroupKey) ||
    compareText(left.workloadGroupKey, right.workloadGroupKey) ||
    compareNullableText(left.containerName, right.containerName) ||
    compareText(left.repository, right.repository)
  )
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0
  }

  return left < right ? -1 : 1
}

// Nulls sort first, as they do in an ascending SQL order.
function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) {
    return 0
  }

  if (left === null) {
    return -1
  }

  if (right === null) {
    return 1
  }

  return compareText(left, right)
}

function countActionType(
  groups: HelmImageUpdateActionGroup[],
  actionType: ImageUpdateActionType
): number {
  return groups.filter(group => group.actionType === actionType).length
}

function statusForRiskRank(riskRank: number): ActionableVersionStatus {
  const status = ACTIONABLE_VERSION_STATUSES.find(
    candidate => VERSION_STATUS_RISK_RANK[candidate] === riskRank
  )

  if (!status) {
    throw new Error(`Unsupported image update risk rank: ${riskRank}`)
  }

  return status
}

export type { ImageUpdateActionGroupCommon }
