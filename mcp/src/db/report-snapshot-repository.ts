import type { Knex } from 'knex'

export const CLUSTER_REPORT_SOURCE_TYPE = 'cluster'
export const READY_REPORT_STATUS = 'ready'
export const ALL_NAMESPACE_SCOPE = JSON.stringify({ mode: 'all' })

interface ReportSnapshotDatabaseRow {
  reportId: string
  clusterContext: string | null
  createdAt: string
}

export interface ReportSnapshot {
  reportId: string
  clusterContext: string
  createdAt: string
}

export interface ReportSnapshotRepository {
  findLatestReadyFullClusterReports(cluster?: string): Promise<ReportSnapshot[]>
}

export class SqliteReportSnapshotRepository implements ReportSnapshotRepository {
  constructor(private readonly database: Knex) {}

  async findLatestReadyFullClusterReports(cluster?: string): Promise<ReportSnapshot[]> {
    const query = this.database<ReportSnapshotDatabaseRow>('reports')
      .select(['id as reportId', 'cluster_context as clusterContext', 'created_at as createdAt'])
      .where('source_type', CLUSTER_REPORT_SOURCE_TYPE)
      .andWhere('namespace_scope', ALL_NAMESPACE_SCOPE)
      .andWhere('status', READY_REPORT_STATUS)

    if (cluster) {
      query.andWhere('cluster_context', cluster)
    }

    const rows = (await query.orderBy([
      { column: 'cluster_context', order: 'asc' },
      { column: 'created_at', order: 'desc' },
      { column: 'id', order: 'desc' }
    ])) as unknown as ReportSnapshotDatabaseRow[]

    return latestReportPerCluster(rows)
  }
}

function latestReportPerCluster(rows: ReportSnapshotDatabaseRow[]): ReportSnapshot[] {
  const reportsByCluster = new Map<string, ReportSnapshot>()

  for (const row of rows) {
    if (!row.clusterContext || reportsByCluster.has(row.clusterContext)) {
      continue
    }

    reportsByCluster.set(row.clusterContext, {
      reportId: row.reportId,
      clusterContext: row.clusterContext,
      createdAt: row.createdAt
    })
  }

  return [...reportsByCluster.values()]
}
