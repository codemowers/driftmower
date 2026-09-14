import { parseReleaseInfo } from '../domain/release-info.js'
import { releaseInfoFor, type ImageUsageRow, type ReportRows, type ReportRowLoader } from './report-rows.js'
import type { ReportSnapshot, ReportSnapshotRepository } from './report-snapshot-repository.js'

interface WorkloadGroupCandidateRow {
  reportId: string
  workloadGroupKey: string
  workloadKind: string | null
  workloadNamespace: string | null
  workloadName: string | null
  searchRepository: string | null
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
}

export interface WorkloadRepository {
  searchMatchingGroups(query: string, limit: number): Promise<MatchingWorkloadGroupRow[]>
  loadWorkloadDetails(selectedGroups: MatchingWorkloadGroupRow[]): Promise<WorkloadDetailRow[]>
}

export class BackendWorkloadRepository implements WorkloadRepository {
  constructor(
    private readonly rowLoader: ReportRowLoader,
    private readonly reportSnapshotRepository: ReportSnapshotRepository
  ) {}

  async searchMatchingGroups(query: string, limit: number): Promise<MatchingWorkloadGroupRow[]> {
    const latestReports = await this.reportSnapshotRepository.findLatestReadyFullClusterReports()

    if (latestReports.length === 0) {
      return []
    }

    const candidates = await this.loadGroupCandidates(latestReports)
    const reportsById = new Map(latestReports.map(report => [report.reportId, report]))
    const normalizedQuery = query.toLocaleLowerCase()

    return candidates
      .map(candidate => enrichMatchingGroup(candidate, reportsById, normalizedQuery))
      .filter((group): group is MatchingWorkloadGroupRow => group !== null)
      .sort(compareMatchingGroups)
      .slice(0, limit)
  }

  async loadWorkloadDetails(selectedGroups: MatchingWorkloadGroupRow[]): Promise<WorkloadDetailRow[]> {
    if (selectedGroups.length === 0) {
      return []
    }

    const groupsById = new Map(selectedGroups.map(group => [workloadGroupId(group), group]))
    const rowsByReport = await this.loadReports(uniqueReportIds(selectedGroups))
    const details: WorkloadDetailRow[] = []

    for (const [reportId, rows] of rowsByReport) {
      // Every image row of each selected workload, with the Helm analysis
      // attached wherever release_group_key names a release score in the same
      // report — the join the SQL used to do.
      const selected = rows.imageUsages
        .filter(usage => groupsById.has(workloadGroupId({ reportId, workloadGroupKey: usage.workloadGroupKey })))
        .sort(compareDetailRows)

      for (const usage of selected) {
        const group = groupsById.get(
          workloadGroupId({ reportId, workloadGroupKey: usage.workloadGroupKey })
        )!

        details.push({
          ...group,
          releaseGroupKey: usage.releaseGroupKey,
          registry: usage.registry,
          repository: usage.repository,
          deployedTag: usage.deployedTag,
          latestTag: usage.latestTag,
          imageStatus: usage.status,
          versionStatus: usage.versionStatus,
          releaseInfo: releaseInfoFor(rows, usage.releaseGroupKey)
        })
      }
    }

    return details
  }

  private async loadGroupCandidates(reports: ReportSnapshot[]): Promise<WorkloadGroupCandidateRow[]> {
    const rowsByReport = await this.loadReports(reports.map(report => report.reportId))
    const candidates = new Map<string, WorkloadGroupCandidateRow>()

    for (const [reportId, rows] of rowsByReport) {
      // One candidate per workload group. Matching and ranking happen here
      // rather than in the query so user input never reaches the backend as a
      // filter expression.
      for (const usage of [...rows.imageUsages].sort(compareCandidateRows)) {
        const id = workloadGroupId({ reportId, workloadGroupKey: usage.workloadGroupKey })

        if (candidates.has(id)) {
          continue
        }

        candidates.set(id, {
          reportId,
          workloadGroupKey: usage.workloadGroupKey,
          workloadKind: usage.workloadKind,
          workloadNamespace: usage.workloadNamespace,
          workloadName: usage.workloadName,
          searchRepository: usage.repository,
          releaseInfo: releaseInfoFor(rows, usage.releaseGroupKey)
        })
      }
    }

    return [...candidates.values()]
  }

  private async loadReports(reportIds: string[]): Promise<Map<string, ReportRows>> {
    const loaded = await Promise.all(
      reportIds.map(async reportId => [reportId, await this.rowLoader.load(reportId)] as const)
    )

    return new Map(loaded)
  }
}

function uniqueReportIds(groups: MatchingWorkloadGroupRow[]): string[] {
  return [...new Set(groups.map(group => group.reportId))]
}

// Row ordering is compared byte-wise, as the backend's database orders text:
// it decides which image row represents a workload group in search, so a
// locale-aware comparison would change which repository a workload can be
// found by.
function compareCandidateRows(left: ImageUsageRow, right: ImageUsageRow): number {
  return (
    compareText(left.workloadGroupKey, right.workloadGroupKey) ||
    compareNullableText(left.workloadName, right.workloadName) ||
    compareText(left.repository, right.repository)
  )
}

function compareDetailRows(left: ImageUsageRow, right: ImageUsageRow): number {
  return (
    compareText(left.workloadGroupKey, right.workloadGroupKey) ||
    compareText(left.repository, right.repository) ||
    compareNullableText(left.containerName, right.containerName)
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

function enrichMatchingGroup(
  candidate: WorkloadGroupCandidateRow,
  reportsById: Map<string, ReportSnapshot>,
  normalizedQuery: string
): MatchingWorkloadGroupRow | null {
  const report = reportsById.get(candidate.reportId)
  const matchRank = rankWorkloadCandidate(candidate, normalizedQuery)

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

function rankWorkloadCandidate(candidate: WorkloadGroupCandidateRow, normalizedQuery: string): number | null {
  const releaseInfo = parseReleaseInfo(candidate.releaseInfo)

  return minNullableRank([
    rankSearchText(candidate.workloadName, normalizedQuery, 0),
    rankSearchText(candidate.workloadNamespace, normalizedQuery, 3),
    rankSearchText(candidate.workloadKind, normalizedQuery, 6),
    rankSearchText(candidate.searchRepository, normalizedQuery, 9),
    rankSearchText(releaseInfo?.name ?? null, normalizedQuery, 12),
    rankSearchText(releaseInfo?.namespace ?? null, normalizedQuery, 12),
    rankSearchText(releaseInfo?.chartName ?? null, normalizedQuery, 12),
    rankSearchText(releaseInfo?.chartVersion ?? null, normalizedQuery, 15),
    rankSearchText(releaseInfo?.latestChartTag ?? null, normalizedQuery, 15)
  ])
}

function rankSearchText(value: string | null, normalizedQuery: string, offset: number): number | null {
  const rank = rankWorkloadName(value, normalizedQuery)

  return rank === null ? null : rank + offset
}

function minNullableRank(ranks: Array<number | null>): number | null {
  const matchedRanks = ranks.filter((rank): rank is number => rank !== null)

  if (matchedRanks.length === 0) {
    return null
  }

  return Math.min(...matchedRanks)
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
  return `${group.reportId} ${group.workloadGroupKey}`
}
