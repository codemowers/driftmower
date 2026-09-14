import type { DriftmowerBackendClient } from './client.js'

export const CLUSTER_REPORT_SOURCE_TYPE = 'cluster'
export const READY_REPORT_STATUS = 'ready'
export const ALL_NAMESPACE_SCOPE_MODE = 'all'
export const IN_CLUSTER_CONTEXT = 'in-cluster'
export const REPORTS_PATH = 'reports'

// Newest-first scan bound. Only the latest ready report per cluster is of
// interest, so the scan stops long before the backend's full report history;
// a cluster that has not produced a ready report within this many reports is
// treated as having none.
const MAXIMUM_SCANNED_PAGES = 5
const SCAN_PAGE_SIZE = 100

// `report` and `rotenness` are deliberately absent: a find without $select
// makes the backend assemble every image usage and release score of every row
// it returns. Selecting is what keeps this read cheap.
const REPORT_SELECTION = ['id', 'clusterContext', 'createdAt', 'namespaceScope']

interface ReportRow {
  id: string
  clusterContext: string | null
  createdAt: string
  // Resolved server-side from the stored JSON, so this arrives as an object.
  namespaceScope: { mode?: string } | null
}

export interface ReportSnapshot {
  reportId: string
  clusterContext: string
  createdAt: string
}

export interface ReportSnapshotRepository {
  findLatestReadyFullClusterReports(cluster?: string): Promise<ReportSnapshot[]>
  findLatestReadyInClusterReport(): Promise<ReportSnapshot | null>
  findReadyInClusterReportById(reportId: string): Promise<ReportSnapshot | null>
}

export class BackendReportSnapshotRepository implements ReportSnapshotRepository {
  constructor(private readonly client: DriftmowerBackendClient) {}

  async findLatestReadyFullClusterReports(cluster?: string): Promise<ReportSnapshot[]> {
    const rows = await this.scanReadyClusterReports(cluster)

    return latestReportPerCluster(rows.filter(isFullClusterReport).sort(compareReportRows))
  }

  async findLatestReadyInClusterReport(): Promise<ReportSnapshot | null> {
    const reports = await this.findLatestReadyFullClusterReports(IN_CLUSTER_CONTEXT)

    return reports[0] ?? null
  }

  async findReadyInClusterReportById(reportId: string): Promise<ReportSnapshot | null> {
    const page = await this.client.findPage<ReportRow>(REPORTS_PATH, {
      id: reportId,
      sourceType: CLUSTER_REPORT_SOURCE_TYPE,
      status: READY_REPORT_STATUS,
      clusterContext: IN_CLUSTER_CONTEXT,
      $select: REPORT_SELECTION,
      $limit: 1
    })
    const row = page.data[0]

    if (!row || !isFullClusterReport(row)) {
      return null
    }

    return toReportSnapshot(row)
  }

  private async scanReadyClusterReports(cluster?: string): Promise<ReportRow[]> {
    const rows: ReportRow[] = []

    for (let page = 0; page < MAXIMUM_SCANNED_PAGES; page += 1) {
      const result = await this.client.findPage<ReportRow>(REPORTS_PATH, {
        sourceType: CLUSTER_REPORT_SOURCE_TYPE,
        status: READY_REPORT_STATUS,
        clusterContext: cluster,
        $select: REPORT_SELECTION,
        $sort: { createdAt: -1 },
        $limit: SCAN_PAGE_SIZE,
        $skip: page * SCAN_PAGE_SIZE
      })

      rows.push(...result.data)

      if (result.data.length < SCAN_PAGE_SIZE || rows.length >= result.total) {
        break
      }
    }

    return rows
  }
}

// Reports scoped to a namespace subset describe part of a cluster, and mixing
// them with full-cluster reports would make a workload look absent when it was
// merely out of scope.
function isFullClusterReport(row: ReportRow): boolean {
  return Boolean(row.clusterContext) && row.namespaceScope?.mode === ALL_NAMESPACE_SCOPE_MODE
}

// Cluster ascending, then newest first, then id descending — the id breaks ties
// between reports sharing a timestamp so the choice is stable across calls.
function compareReportRows(left: ReportRow, right: ReportRow): number {
  return (
    (left.clusterContext ?? '').localeCompare(right.clusterContext ?? '') ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  )
}

function latestReportPerCluster(rows: ReportRow[]): ReportSnapshot[] {
  const reportsByCluster = new Map<string, ReportSnapshot>()

  for (const row of rows) {
    if (!row.clusterContext || reportsByCluster.has(row.clusterContext)) {
      continue
    }

    reportsByCluster.set(row.clusterContext, toReportSnapshot(row))
  }

  return [...reportsByCluster.values()]
}

function toReportSnapshot(row: ReportRow): ReportSnapshot {
  return {
    reportId: row.id,
    clusterContext: row.clusterContext as string,
    createdAt: row.createdAt
  }
}
