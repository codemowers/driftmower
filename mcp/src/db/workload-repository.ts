import type { Knex } from 'knex'

const CLUSTER_SOURCE_TYPE = 'cluster'
// TODO ineffective querying, remove after MVP scope, make it better
const ALL_NAMESPACE_SCOPE = JSON.stringify({ mode: 'all' })

interface ReportRow {
  id: string
  clusterContext: string | null
  createdAt: string
}

interface WorkloadGroupCandidateRow {
  reportId: string
  workloadGroupKey: string
  workloadKind: string | null
  workloadNamespace: string | null
  workloadName: string | null
}

interface WorkloadDetailDatabaseRow extends WorkloadGroupCandidateRow {
  releaseGroupKey: string | null
  registry: string
  repository: string
  deployedTag: string | null
  latestTag: string | null
  imageStatus: string
  versionStatus: string | null
  releaseInfo: string | null
}

export interface MatchingWorkloadGroupRow extends WorkloadGroupCandidateRow {
  clusterContext: string
  reportCreatedAt: string
  matchRank: number
}

export interface WorkloadDetailRow extends MatchingWorkloadGroupRow {
  releaseGroupKey: string | null
  registry: string
  repository: string
  deployedTag: string | null
  latestTag: string | null
  imageStatus: string
  versionStatus: string | null
  releaseInfo: string | null
}

export interface WorkloadRepository {
  searchMatchingGroups(query: string, limit: number): Promise<MatchingWorkloadGroupRow[]>
  loadWorkloadDetails(selectedGroups: MatchingWorkloadGroupRow[]): Promise<WorkloadDetailRow[]>
}

export class SqliteWorkloadRepository implements WorkloadRepository {
  constructor(private readonly database: Knex) {}

  async searchMatchingGroups(query: string, limit: number): Promise<MatchingWorkloadGroupRow[]> {
    const latestReports = await this.loadLatestFullClusterReports()

    if (latestReports.length === 0) {
      return []
    }

    const candidates = await this.loadGroupCandidates(latestReports.map(report => report.id))
    const reportsById = new Map(latestReports.map(report => [report.id, report]))
    const normalizedQuery = query.toLocaleLowerCase()

    return uniqueGroupCandidates(candidates)
      .map(candidate => enrichMatchingGroup(candidate, reportsById, normalizedQuery))
      .filter((group): group is MatchingWorkloadGroupRow => group !== null)
      .sort(compareMatchingGroups)
      .slice(0, limit)
  }

  async loadWorkloadDetails(selectedGroups: MatchingWorkloadGroupRow[]): Promise<WorkloadDetailRow[]> {
    if (selectedGroups.length === 0) {
      return []
    }

    const rows = await this.buildDetailQuery(selectedGroups)
    const groupsById = new Map(selectedGroups.map(group => [workloadGroupId(group), group]))

    return rows.map(row => ({
      ...row,
      ...groupsById.get(workloadGroupId(row))!
    }))
  }

  private async loadLatestFullClusterReports(): Promise<ReportRow[]> {
    // Fetch full-cluster snapshot candidates newest-first within each cluster.
    // TypeScript selects the first row per cluster to avoid a database-specific window query.
    const rows = (await this.database<ReportRow>('reports')
      .select([
        'id',
        'cluster_context as clusterContext',
        'created_at as createdAt'
      ])
      .where('source_type', CLUSTER_SOURCE_TYPE)
      .andWhere('namespace_scope', ALL_NAMESPACE_SCOPE)
      .orderBy([
        { column: 'cluster_context', order: 'asc' },
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])) as unknown as ReportRow[]

    return latestReportPerCluster(rows)
  }

  private async loadGroupCandidates(reportIds: string[]): Promise<WorkloadGroupCandidateRow[]> {
    // Find distinct workload identities only in the selected latest reports.
    // Name matching and ranking happen in TypeScript so user input never becomes SQL text.
    return (await this.database<WorkloadGroupCandidateRow>('image_usages as iu')
      .distinct([
        'iu.report_id as reportId',
        'iu.workload_group_key as workloadGroupKey',
        'iu.workload_kind as workloadKind',
        'iu.workload_namespace as workloadNamespace',
        'iu.workload_name as workloadName'
      ])
      .whereIn('iu.report_id', reportIds)
      .whereNotNull('iu.workload_name')
      .orderBy([
        { column: 'iu.report_id', order: 'asc' },
        { column: 'iu.workload_group_key', order: 'asc' },
        { column: 'iu.workload_name', order: 'asc' }
      ])) as WorkloadGroupCandidateRow[]
  }

  private buildDetailQuery(selectedGroups: MatchingWorkloadGroupRow[]): Promise<WorkloadDetailDatabaseRow[]> {
    // Load every image row for each selected workload and attach persisted Helm analysis when
    // release_group_key identifies a matching release score in the same report snapshot.
    return this.database<WorkloadDetailDatabaseRow>('image_usages as iu')
      .select([
        'iu.report_id as reportId',
        'iu.workload_group_key as workloadGroupKey',
        'iu.workload_kind as workloadKind',
        'iu.workload_namespace as workloadNamespace',
        'iu.workload_name as workloadName',
        'iu.release_group_key as releaseGroupKey',
        'iu.registry',
        'iu.repository',
        'iu.deployed_tag as deployedTag',
        'iu.latest_tag as latestTag',
        'iu.status as imageStatus',
        'iu.version_status as versionStatus',
        'rs.release_info as releaseInfo'
      ])
      .leftJoin('release_scores as rs', join => {
        join.on('rs.report_id', '=', 'iu.report_id')
        join.andOn('rs.group_key', '=', 'iu.release_group_key')
      })
      .where(builder => addSelectedGroupConditions(builder, selectedGroups))
      .orderBy([
        { column: 'iu.workload_group_key', order: 'asc' },
        { column: 'iu.repository', order: 'asc' },
        { column: 'iu.container_name', order: 'asc' }
      ]) as unknown as Promise<WorkloadDetailDatabaseRow[]>
  }
}

function latestReportPerCluster(rows: ReportRow[]): ReportRow[] {
  const reportsByCluster = new Map<string, ReportRow>()

  for (const row of rows) {
    if (!row.clusterContext || reportsByCluster.has(row.clusterContext)) {
      continue
    }

    reportsByCluster.set(row.clusterContext, row)
  }

  return [...reportsByCluster.values()]
}

function uniqueGroupCandidates(rows: WorkloadGroupCandidateRow[]): WorkloadGroupCandidateRow[] {
  const groups = new Map<string, WorkloadGroupCandidateRow>()

  for (const row of rows) {
    const id = workloadGroupId(row)

    if (!groups.has(id)) {
      groups.set(id, row)
    }
  }

  return [...groups.values()]
}

function enrichMatchingGroup(
  candidate: WorkloadGroupCandidateRow,
  reportsById: Map<string, ReportRow>,
  normalizedQuery: string
): MatchingWorkloadGroupRow | null {
  const report = reportsById.get(candidate.reportId)
  const matchRank = rankWorkloadName(candidate.workloadName, normalizedQuery)

  if (!report?.clusterContext || matchRank === null) {
    return null
  }

  return {
    ...candidate,
    clusterContext: report.clusterContext,
    reportCreatedAt: report.createdAt,
    matchRank
  }
}

export function rankWorkloadName(workloadName: string | null, normalizedQuery: string): number | null {
  // This exact/prefix/substring ranking is a deliberately simple MVP heuristic, not an optimal
  // search strategy. A later version could use fuzzy similarity such as Jaro-Winkler and ask the
  // user to clarify when several workloads are plausible matches; that is outside the MVP scope.
  const normalizedName = workloadName?.toLocaleLowerCase()

  if (!normalizedName || !normalizedName.includes(normalizedQuery)) {
    return null
  }

  if (normalizedName === normalizedQuery) {
    return 0
  }

  return normalizedName.startsWith(normalizedQuery) ? 1 : 2
}

function compareMatchingGroups(left: MatchingWorkloadGroupRow, right: MatchingWorkloadGroupRow): number {
  return (
    left.matchRank - right.matchRank ||
    compareNullableStrings(left.workloadName, right.workloadName) ||
    left.clusterContext.localeCompare(right.clusterContext) ||
    compareNullableStrings(left.workloadNamespace, right.workloadNamespace) ||
    left.workloadGroupKey.localeCompare(right.workloadGroupKey)
  )
}

function compareNullableStrings(left: string | null, right: string | null): number {
  return (left ?? '').localeCompare(right ?? '', undefined, { sensitivity: 'base' })
}

function workloadGroupId(group: Pick<WorkloadGroupCandidateRow, 'reportId' | 'workloadGroupKey'>): string {
  return `${group.reportId}\u0000${group.workloadGroupKey}`
}

function addSelectedGroupConditions(
  builder: Knex.QueryBuilder,
  selectedGroups: MatchingWorkloadGroupRow[]
): void {
  for (const group of selectedGroups) {
    builder.orWhere(groupBuilder => {
      groupBuilder
        .where('iu.report_id', group.reportId)
        .andWhere('iu.workload_group_key', group.workloadGroupKey)
    })
  }
}
