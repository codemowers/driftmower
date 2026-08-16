import type {
  HelmAnalysis,
  ImageAnalysis,
  SearchWorkloadsResult,
  WorkloadMatch
} from '../domain/workload-result.js'
import type {
  MatchingWorkloadGroupRow,
  WorkloadDetailRow,
  WorkloadRepository
} from '../db/workload-repository.js'
import { parseReleaseInfo } from '../domain/release-info.js'

const CURRENT_VERSION_STATUSES = new Set(['up_to_date', 'current'])

export interface SearchWorkloadsInput {
  query: string
  limit?: number
}

export class WorkloadSearchService {
  constructor(
    private readonly repository: WorkloadRepository,
    private readonly defaultLimit: number,
    private readonly maximumLimit: number
  ) {}

  async searchWorkloads(input: SearchWorkloadsInput): Promise<SearchWorkloadsResult> {
    const query = input.query.trim()

    if (query.length === 0) {
      throw new Error('query must be a non-empty string')
    }

    const limit = normalizeLimit(input.limit, this.defaultLimit, this.maximumLimit)
    const groups = await this.repository.searchMatchingGroups(query, limit)
    const details = await this.repository.loadWorkloadDetails(groups)
    const detailsByGroup = groupDetails(details)

    return {
      query,
      matches: groups.map(group => mapWorkloadMatch(group, detailsByGroup.get(groupId(group)) ?? []))
    }
  }
}

function normalizeLimit(limit: number | undefined, defaultLimit: number, maximumLimit: number): number {
  const requestedLimit = limit ?? defaultLimit

  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('limit must be a positive integer')
  }

  return Math.min(requestedLimit, maximumLimit)
}

function groupDetails(rows: WorkloadDetailRow[]): Map<string, WorkloadDetailRow[]> {
  const groupedRows = new Map<string, WorkloadDetailRow[]>()

  for (const row of rows) {
    const id = groupId(row)
    const groupRows = groupedRows.get(id) ?? []

    groupRows.push(row)
    groupedRows.set(id, groupRows)
  }

  return groupedRows
}

function mapWorkloadMatch(group: MatchingWorkloadGroupRow, rows: WorkloadDetailRow[]): WorkloadMatch {
  return {
    workloadId: group.workloadGroupKey,
    name: group.workloadName,
    kind: group.workloadKind,
    cluster: group.clusterContext,
    namespace: group.workloadNamespace,
    analysis: {
      status: selectStatus(rows),
      helm: selectHelmAnalysis(rows),
      images: selectImages(rows)
    },
    snapshot: {
      reportId: group.reportId,
      createdAt: group.reportCreatedAt
    }
  }
}

function selectStatus(rows: WorkloadDetailRow[]): string | null {
  const versionStatuses = rows
    .map(row => row.versionStatus)
    .filter((status): status is string => status !== null)

  return (
    versionStatuses.find(status => !CURRENT_VERSION_STATUSES.has(status)) ??
    versionStatuses[0] ??
    rows.find(row => row.imageStatus)?.imageStatus ??
    null
  )
}

function selectImages(rows: WorkloadDetailRow[]): ImageAnalysis[] {
  const images = new Map<string, ImageAnalysis>()

  for (const row of rows) {
    const image: ImageAnalysis = {
      registry: row.registry,
      repository: row.repository,
      observedTag: row.deployedTag,
      latestKnownTag: row.latestTag,
      status: row.imageStatus,
      versionStatus: row.versionStatus
    }
    const key = JSON.stringify(image)

    if (!images.has(key)) {
      images.set(key, image)
    }
  }

  return [...images.values()].sort(compareImages)
}

function compareImages(left: ImageAnalysis, right: ImageAnalysis): number {
  return (
    left.registry.localeCompare(right.registry) ||
    left.repository.localeCompare(right.repository) ||
    compareNullableStrings(left.observedTag, right.observedTag) ||
    compareNullableStrings(left.latestKnownTag, right.latestKnownTag) ||
    compareNullableStrings(left.status, right.status) ||
    compareNullableStrings(left.versionStatus, right.versionStatus)
  )
}

function selectHelmAnalysis(rows: WorkloadDetailRow[]): HelmAnalysis | null {
  for (const row of rows) {
    if (!row.releaseGroupKey || !row.releaseInfo) {
      continue
    }

    const releaseInfo = parseReleaseInfo(row.releaseInfo)

    if (releaseInfo) {
      return {
        releaseName: releaseInfo.name ?? null,
        releaseNamespace: releaseInfo.namespace ?? null,
        chartName: releaseInfo.chartName ?? null,
        observedChartVersion: releaseInfo.chartVersion ?? null,
        latestKnownChartVersion: releaseInfo.latestChartTag ?? null,
        appVersion: releaseInfo.chartAppVersion ?? null
      }
    }
  }

  return null
}

function compareNullableStrings(left: string | null, right: string | null): number {
  return (left ?? '').localeCompare(right ?? '')
}

function groupId(group: Pick<MatchingWorkloadGroupRow, 'reportId' | 'workloadGroupKey'>): string {
  return `${group.reportId}\u0000${group.workloadGroupKey}`
}
