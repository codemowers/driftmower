import type { Knex } from 'knex'
import {
  ACTIONABLE_VERSION_STATUSES,
  VERSION_STATUS_RISK_RANK,
  type ActionableVersionStatus,
  type ImageUpdateActionSortKey,
  type ImageUpdateActionType,
  type ImageUpdatePlanSummary
} from '../domain/image-update-plan.js'

const IMAGE_TAG_UPDATE_ACTION_TYPE = 'image_tag_update' as const
const HELM_CHART_UPDATE_ACTION_TYPE = 'helm_chart_update' as const
const MANUAL_REVIEW_ACTION_TYPE = 'manual_review' as const

const OBSERVED_CHART_VERSION_SQL = "trim(CAST(json_extract(rs.release_info, '$.chartVersion') AS TEXT))"
const LATEST_CHART_VERSION_SQL = "trim(CAST(json_extract(rs.release_info, '$.latestChartTag') AS TEXT))"
const NORMALIZED_OBSERVED_CHART_VERSION_SQL = normalizeVersionSql(OBSERVED_CHART_VERSION_SQL)
const NORMALIZED_LATEST_CHART_VERSION_SQL = normalizeVersionSql(LATEST_CHART_VERSION_SQL)

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

interface ImageUpdateActionGroupDatabaseRow {
  reportId: string
  actionType: ImageUpdateActionType
  riskRank: number
  namespace: string
  groupKey: string
  releaseGroupKey: string | null
  workloadGroupKey: string | null
  workloadKind: string | null
  workloadNamespace: string | null
  workloadName: string | null
  containerName: string | null
  registry: string | null
  repository: string | null
  deployedTag: string | null
  latestTag: string | null
}

interface CountDatabaseRow {
  count: number | string
}

interface ActionTypeCountDatabaseRow extends CountDatabaseRow {
  actionType: ImageUpdateActionType
}

export interface ImageUpdateRepository {
  listActionGroups(input: ListImageUpdateActionGroupsInput): Promise<ImageUpdateActionGroup[]>
  loadActionDetails(input: LoadImageUpdateActionDetailsInput): Promise<ImageUpdateActionDetailRow[]>
  summarizeActions(input: ImageUpdateRepositoryFilters): Promise<ImageUpdatePlanSummary>
}

export class SqliteImageUpdateRepository implements ImageUpdateRepository {
  constructor(private readonly database: Knex) {}

  async listActionGroups(input: ListImageUpdateActionGroupsInput): Promise<ImageUpdateActionGroup[]> {
    const union = this.database
      .unionAll([this.buildDirectGroups(input), this.buildHelmGroups(input)])
      .as('action_groups')
    const query = this.database.from(union).select('*')

    addKeysetCondition(query, input.after)

    const rows = (await query
      .orderBy([
        { column: 'riskRank', order: 'asc' },
        { column: 'actionType', order: 'asc' },
        { column: 'namespace', order: 'asc' },
        { column: 'groupKey', order: 'asc' }
      ])
      .limit(input.limit)) as ImageUpdateActionGroupDatabaseRow[]

    return rows.map(mapActionGroup)
  }

  async loadActionDetails(input: LoadImageUpdateActionDetailsInput): Promise<ImageUpdateActionDetailRow[]> {
    if (input.groups.length === 0) {
      return []
    }

    const query = this.buildActionDetailsQuery(input)

    query.andWhere(builder => addGroupConditions(builder, input.groups))

    return (await query.orderBy([
      { column: 'iu.release_group_key', order: 'asc' },
      { column: 'iu.workload_group_key', order: 'asc' },
      { column: 'iu.container_name', order: 'asc' },
      { column: 'iu.repository', order: 'asc' }
    ])) as ImageUpdateActionDetailRow[]
  }

  private buildActionDetailsQuery(input: ImageUpdateRepositoryFilters): Knex.QueryBuilder {
    const query = this.database('image_usages as iu')
      .select([
        'iu.report_id as reportId',
        'iu.workload_group_key as workloadGroupKey',
        'iu.workload_kind as workloadKind',
        'iu.workload_namespace as workloadNamespace',
        'iu.workload_name as workloadName',
        'iu.release_group_key as releaseGroupKey',
        'iu.container_name as containerName',
        'iu.registry',
        'iu.repository',
        'iu.deployed_tag as deployedTag',
        'iu.latest_tag as latestTag',
        'iu.version_status as versionStatus',
        'rs.release_info as releaseInfo'
      ])
      .leftJoin('release_scores as rs', join => {
        join.on('rs.report_id', '=', 'iu.report_id')
        join.andOn('rs.group_key', '=', 'iu.release_group_key')
      })

    applyFilters(query, input)

    return query
  }

  async summarizeActions(input: ImageUpdateRepositoryFilters): Promise<ImageUpdatePlanSummary> {
    const directGroups = this.buildDirectGroups(input).as('direct_groups')
    const helmGroups = this.buildHelmGroups(input).as('helm_groups')
    const imageCandidates = this.buildUniqueImageCandidates(input).as('image_candidates')
    const [directRows, helmRows, imageRows] = await Promise.all([
      this.database.from(directGroups).count<CountDatabaseRow[]>({ count: '*' }),
      this.database
        .from(helmGroups)
        .select('actionType')
        .count<ActionTypeCountDatabaseRow[]>({ count: '*' })
        .groupBy('actionType'),
      this.database.from(imageCandidates).count<CountDatabaseRow[]>({ count: '*' })
    ])
    const imageTagUpdates = countValue(directRows[0])
    const helmChartUpdates = actionTypeCount(helmRows, HELM_CHART_UPDATE_ACTION_TYPE)
    const manualReviews = actionTypeCount(helmRows, MANUAL_REVIEW_ACTION_TYPE)

    return {
      uniqueImageCandidates: countValue(imageRows[0]),
      totalActions: imageTagUpdates + helmChartUpdates + manualReviews,
      imageTagUpdates,
      helmChartUpdates,
      manualReviews
    }
  }

  private buildDirectGroups(input: ImageUpdateRepositoryFilters): Knex.QueryBuilder {
    const query = this.database('image_usages as iu')
      .select(directGroupSelection(this.database))
      .whereNull('iu.release_group_key')
      .groupBy([
        'iu.report_id',
        'iu.workload_group_key',
        'iu.container_name',
        'iu.registry',
        'iu.repository',
        'iu.deployed_tag',
        'iu.latest_tag'
      ])

    applyFilters(query, input)

    return query
  }

  private buildHelmGroups(input: ImageUpdateRepositoryFilters): Knex.QueryBuilder {
    const query = this.database('image_usages as iu')
      .select(helmGroupSelection(this.database))
      .leftJoin('release_scores as rs', join => {
        join.on('rs.report_id', '=', 'iu.report_id')
        join.andOn('rs.group_key', '=', 'iu.release_group_key')
      })
      .whereNotNull('iu.release_group_key')
      .groupBy(['iu.report_id', 'iu.release_group_key', 'rs.release_info'])

    applyFilters(query, input)

    return query
  }

  private buildUniqueImageCandidates(input: ImageUpdateRepositoryFilters): Knex.QueryBuilder {
    const query = this.database('image_usages as iu')
      .select('iu.report_id')
      .groupBy([
        'iu.report_id',
        'iu.workload_group_key',
        'iu.container_name',
        'iu.registry',
        'iu.repository',
        'iu.deployed_tag',
        'iu.latest_tag'
      ])

    applyFilters(query, input)

    return query
  }
}

function applyFilters(query: Knex.QueryBuilder, input: ImageUpdateRepositoryFilters): void {
  query
    .where('iu.report_id', input.reportId)
    .whereIn('iu.version_status', input.versionStatuses)
    .whereNotNull('iu.latest_tag')

  if (input.namespace !== null) {
    query.andWhere('iu.workload_namespace', input.namespace)
  }
}

function addKeysetCondition(query: Knex.QueryBuilder, after: ImageUpdateActionSortKey | null): void {
  if (after === null) {
    return
  }

  query.where(builder => {
    builder
      .where('riskRank', '>', after.riskRank)
      .orWhere(inner => {
        inner.where('riskRank', after.riskRank).andWhere('actionType', '>', after.actionType)
      })
      .orWhere(inner => {
        inner
          .where('riskRank', after.riskRank)
          .andWhere('actionType', after.actionType)
          .andWhere('namespace', '>', after.namespace)
      })
      .orWhere(inner => {
        inner
          .where('riskRank', after.riskRank)
          .andWhere('actionType', after.actionType)
          .andWhere('namespace', after.namespace)
          .andWhere('groupKey', '>', after.groupKey)
      })
  })
}

function addGroupConditions(builder: Knex.QueryBuilder, groups: ImageUpdateActionGroup[]): void {
  for (const group of groups) {
    builder.orWhere(groupBuilder => {
      if (group.releaseGroupKey !== null) {
        groupBuilder.where('iu.release_group_key', group.releaseGroupKey)

        return
      }

      groupBuilder
        .whereNull('iu.release_group_key')
        .andWhere('iu.workload_group_key', group.workloadGroupKey)
        .andWhere('iu.registry', group.registry)
        .andWhere('iu.repository', group.repository)
        .andWhere('iu.latest_tag', group.latestTag)
      addNullableCondition(groupBuilder, 'iu.container_name', group.containerName)
      addNullableCondition(groupBuilder, 'iu.deployed_tag', group.deployedTag)
    })
  }
}

function addNullableCondition(builder: Knex.QueryBuilder, column: string, value: string | null): void {
  if (value === null) {
    builder.whereNull(column)

    return
  }

  builder.andWhere(column, value)
}

function riskRankExpression(database: Knex): Knex.Raw {
  const bindings: Array<string | number> = ['iu.version_status']
  const cases = ACTIONABLE_VERSION_STATUSES.map(status => {
    bindings.push(status, VERSION_STATUS_RISK_RANK[status])

    return 'WHEN ? THEN ?'
  })
  const fallbackRank = Math.max(...Object.values(VERSION_STATUS_RISK_RANK))

  bindings.push(fallbackRank)

  return database.raw(`MIN(CASE ?? ${cases.join(' ')} ELSE ? END)`, bindings)
}

function directGroupKeyExpression(database: Knex): Knex.Raw {
  return database.raw(
    `json_array(
      iu.workload_group_key,
      iu.container_name,
      iu.registry,
      iu.repository,
      iu.deployed_tag,
      iu.latest_tag
    )`
  )
}

function directGroupSelection(database: Knex): Record<string, string | Knex.Raw> {
  return {
    reportId: 'iu.report_id',
    actionType: database.raw('?', [IMAGE_TAG_UPDATE_ACTION_TYPE]),
    riskRank: riskRankExpression(database),
    namespace: database.raw("COALESCE(MIN(iu.workload_namespace), '')"),
    groupKey: directGroupKeyExpression(database),
    releaseGroupKey: database.raw('NULL'),
    workloadGroupKey: 'iu.workload_group_key',
    workloadKind: database.raw('MIN(iu.workload_kind)'),
    workloadNamespace: database.raw('MIN(iu.workload_namespace)'),
    workloadName: database.raw('MIN(iu.workload_name)'),
    containerName: 'iu.container_name',
    registry: 'iu.registry',
    repository: 'iu.repository',
    deployedTag: 'iu.deployed_tag',
    latestTag: 'iu.latest_tag'
  }
}

function helmGroupSelection(database: Knex): Record<string, string | Knex.Raw> {
  return {
    reportId: 'iu.report_id',
    actionType: helmActionTypeExpression(database),
    riskRank: riskRankExpression(database),
    namespace: database.raw(
      "COALESCE(json_extract(rs.release_info, '$.namespace'), MIN(iu.workload_namespace), '')"
    ),
    groupKey: 'iu.release_group_key',
    releaseGroupKey: 'iu.release_group_key',
    workloadGroupKey: database.raw('NULL'),
    workloadKind: database.raw('NULL'),
    workloadNamespace: database.raw('NULL'),
    workloadName: database.raw('NULL'),
    containerName: database.raw('NULL'),
    registry: database.raw('NULL'),
    repository: database.raw('NULL'),
    deployedTag: database.raw('NULL'),
    latestTag: database.raw('NULL')
  }
}

function helmActionTypeExpression(database: Knex): Knex.Raw {
  return database.raw(
    `CASE
      WHEN json_type(rs.release_info, '$.chartVersion') = 'text'
        AND json_type(rs.release_info, '$.latestChartTag') = 'text'
        AND length(${NORMALIZED_OBSERVED_CHART_VERSION_SQL}) > 0
        AND length(${NORMALIZED_LATEST_CHART_VERSION_SQL}) > 0
        AND ${NORMALIZED_OBSERVED_CHART_VERSION_SQL} <> ${NORMALIZED_LATEST_CHART_VERSION_SQL}
      THEN ?
      ELSE ?
    END`,
    [HELM_CHART_UPDATE_ACTION_TYPE, MANUAL_REVIEW_ACTION_TYPE]
  )
}

function normalizeVersionSql(expression: string): string {
  return `CASE WHEN substr(${expression}, 1, 1) = 'v' THEN substr(${expression}, 2) ELSE ${expression} END`
}

function mapActionGroup(row: ImageUpdateActionGroupDatabaseRow): ImageUpdateActionGroup {
  const versionStatus = statusForRiskRank(row.riskRank)
  const base: ImageUpdateActionGroupCommon = {
    reportId: row.reportId,
    riskRank: row.riskRank,
    versionStatus,
    namespace: row.namespace,
    groupKey: row.groupKey
  }

  if (row.actionType !== IMAGE_TAG_UPDATE_ACTION_TYPE) {
    return mapHelmActionGroup(row, base)
  }

  return mapDirectActionGroup(row, base)
}

function mapHelmActionGroup(
  row: ImageUpdateActionGroupDatabaseRow,
  base: ImageUpdateActionGroupCommon
): HelmImageUpdateActionGroup {
  if (!row.releaseGroupKey || row.actionType === IMAGE_TAG_UPDATE_ACTION_TYPE) {
    throw new Error('Helm action group is missing a release group key')
  }

  return {
    ...base,
    actionType: row.actionType,
    releaseGroupKey: row.releaseGroupKey,
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
}

function mapDirectActionGroup(
  row: ImageUpdateActionGroupDatabaseRow,
  base: ImageUpdateActionGroupCommon
): DirectImageUpdateActionGroup {
  if (!row.workloadGroupKey || !row.registry || !row.repository || !row.latestTag) {
    throw new Error('Direct action group is missing image identity fields')
  }

  return {
    ...base,
    actionType: IMAGE_TAG_UPDATE_ACTION_TYPE,
    releaseGroupKey: null,
    workloadGroupKey: row.workloadGroupKey,
    workloadKind: row.workloadKind,
    workloadNamespace: row.workloadNamespace,
    workloadName: row.workloadName,
    containerName: row.containerName,
    registry: row.registry,
    repository: row.repository,
    deployedTag: row.deployedTag,
    latestTag: row.latestTag
  }
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

function countValue(row: CountDatabaseRow | undefined): number {
  return Number(row?.count ?? 0)
}

function actionTypeCount(rows: ActionTypeCountDatabaseRow[], actionType: ImageUpdateActionType): number {
  return countValue(rows.find(row => row.actionType === actionType))
}
