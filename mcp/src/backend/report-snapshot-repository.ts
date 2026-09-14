import type { DriftmowerBackendClient } from './client.js'

export const CLUSTER_REPORT_SOURCE_TYPE = 'cluster'
export const READY_REPORT_STATUS = 'ready'
export const ALL_NAMESPACE_SCOPE_MODE = 'all'
// The backend stores namespace_scope as canonical JSON text and lets a query
// match it as a string, so full-cluster reports can be selected server-side
// rather than fetched and discarded.
export const ALL_NAMESPACE_SCOPE = JSON.stringify({ mode: ALL_NAMESPACE_SCOPE_MODE })
export const IN_CLUSTER_CONTEXT = 'in-cluster'
export const REPORTS_PATH = 'reports'

// Newest-first scan bound for the all-clusters listing. Every row read is
// already a ready full-cluster report, so this only truncates when more than
// this many such reports are newer than some cluster's latest one — a cluster
// that quiet is treated as having none.
const MAXIMUM_SCANNED_PAGES = 5

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
    const query = {
      ...READY_FULL_CLUSTER_REPORT_FILTER,
      clusterContext: cluster,
      $select: REPORT_SELECTION,
      // Newest first; the id breaks ties between reports sharing a timestamp
      // so both the pick and the page boundaries are stable across calls.
      $sort: { createdAt: -1, id: -1 }
    }

    // One cluster: the first row in this order is the answer.
    if (cluster !== undefined) {
      const page = await this.client.findPage<ReportRow>(REPORTS_PATH, { ...query, $limit: 1 })

      return latestReportPerCluster(page.data.filter(isFullClusterReport))
    }

    const rows = await this.client.findAll<ReportRow>(REPORTS_PATH, query, {
      maximumPages: MAXIMUM_SCANNED_PAGES,
      onLimit: 'truncate'
    })

    return latestReportPerCluster(rows.filter(isFullClusterReport).sort(compareReportRows))
  }

  async findLatestReadyInClusterReport(): Promise<ReportSnapshot | null> {
    const reports = await this.findLatestReadyFullClusterReports(IN_CLUSTER_CONTEXT)

    return reports[0] ?? null
  }

  async findReadyInClusterReportById(reportId: string): Promise<ReportSnapshot | null> {
    const page = await this.client.findPage<ReportRow>(REPORTS_PATH, {
      ...READY_FULL_CLUSTER_REPORT_FILTER,
      id: reportId,
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
}

const READY_FULL_CLUSTER_REPORT_FILTER = {
  sourceType: CLUSTER_REPORT_SOURCE_TYPE,
  status: READY_REPORT_STATUS,
  namespaceScope: ALL_NAMESPACE_SCOPE
}

// Reports scoped to a namespace subset describe part of a cluster, and mixing
// them with full-cluster reports would make a workload look absent when it was
// merely out of scope. The query already asks for full-cluster reports; this
// re-checks the resolved value so a backend that stored the scope in another
// spelling cannot slip a partial report through.
function isFullClusterReport(row: ReportRow): boolean {
  return Boolean(row.clusterContext) && row.namespaceScope?.mode === ALL_NAMESPACE_SCOPE_MODE
}

// Cluster ascending, then newest first, then id descending, compared byte-wise
// as the backend orders them — the id breaks ties between reports sharing a
// timestamp so the choice is stable across calls.
function compareReportRows(left: ReportRow, right: ReportRow): number {
  return (
    compareText(left.clusterContext ?? '', right.clusterContext ?? '') ||
    compareText(right.createdAt, left.createdAt) ||
    compareText(right.id, left.id)
  )
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0
  }

  return left < right ? -1 : 1
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
