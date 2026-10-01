import { useClusterState } from "./cluster-state"
import { REPORTS_URL } from "./constants"
import { fetchJson } from "@/lib/utils/fetch-json"

export type StatusType = "up_to_date" | "patch_behind" | "minor_behind" | "major_behind" | "ahead" | "behind" | "no_data" | "no_version"

export type ReleaseInfo = {
  managementKind: string
  name: string
  namespace: string
  uid: string
  groupKey: string
  chartName: string
  chartVersion: string
  chartAppVersion: string
  revision?: number
  helmStatus?: string
  firstDeployedAt?: string
  lastDeployedAt?: string
  chartSource?: string
  chartSourceKind?: string
  chartRegistry?: string
  chartRepository?: string
  chartRepoUrl?: string
  chartSourceVersion?: string
  chartTags?: string[]
  latestChartTag?: string
}

export type ReleaseScore = {
  groupKey: string
  releaseInfo: ReleaseInfo
  normalizedScore: number
  distinctRepoCount: number
  staleRepoCount: number
  totalWorkloadCount: number
  totalContainers: number
}

export type WorkloadScore = {
  groupKey: string
  normalizedScore: number
  distinctRepoCount: number
  staleRepoCount: number
  totalContainers: number
  workloadRootInfo: {
    kind: string
    name: string
    namespace: string
    uid: string
    groupKey: string
  }
}

export type ScrapeStatus = {
  timestamp: number
  success: boolean
  partial: boolean
  reason: string
  filteredTagCount: number
  lastScrape: string
}

export type ImageUsage = {
  context: string
  namespace: string
  podName: string
  uid: string
  containerName: string
  image: string
  originalImage: string
  imageId: string
  controllerKind: string
  controllerName: string
  hasImagePullSecrets: boolean
  actualTag: string
  allActualTags: string[]
  tagStatus: string
  digestSemver: { tag: string; versionTuple: [number, number, number]; suffix: string } | null
  imageInfo: {
    registry: string
    repository: string
    tag: string
    digest: string
    repositoryUrl?: string
    tagUrl?: string
    labels?: Record<string, string>
    endOfLifeDate?: string
    endOfActiveSupportDate?: string
  }
  versionStatus: {
    statusType: StatusType
    deployedTag: string | null
    latestTag: string | null
    majorDifference: number
    minorDifference: number
    patchDifference: number
    deployedBuiltAt?: string
    latestBuiltAt?: string
  }
  workloadRootInfo: {
    kind: string
    apiGroup?: string
    qualifiedKind?: string
    name: string
    namespace: string
    uid: string
    groupKey: string
  } | null
  releaseInfo: ReleaseInfo | null
}

export type Issue = {
  image: string
  type: string
  message: string
  reason: string
}

export type Report = {
  id: string
  sourceType: "cluster"
  clusterContext: string
  createdAt: string
  updatedAt: string | null
  status: string
  reportHash: string
  previousReportId: string | null
  report: {
    imageUsages: ImageUsage[]
    releaseGroupMap: Record<string, ImageUsage[]>
    workloadGroupMap: Record<string, ImageUsage[]>
    excludedContainerCount: number
    registryRepoMap?: Record<string, unknown>
    availableTagsMap?: Record<string, string[]>
    consideredTagsMap?: Record<string, string[]>
    filteredTagsMap?: Record<string, string[]>
    irrelevantTagsMap?: Record<string, string[]>
    latestSemverMap?: Record<string, string>
    scrapeStatusMap?: Record<string, ScrapeStatus>
  }
  rotenness: {
    normalizedScore: number
    totalContainers: number
    containerScores: Record<string, unknown>
    releaseScores: Record<string, ReleaseScore>
    workloadScores: Record<string, WorkloadScore>
    repoScores: Record<string, unknown>
  }
  issues: Issue[]
}

type ReportsListResponse = {
  total: number
  limit: number
  skip: number
  data: Report[]
}

function parseReportDate(createdAt: string): Date {
  return new Date(createdAt.replace(" ", "T") + "Z")
}

const ZERO_DATE_PREFIX = "0001-01-01"

function normalizeBuiltAt(value?: string): string | undefined {
  return value && !value.startsWith(ZERO_DATE_PREFIX) ? value : undefined
}

function normalizeReport(report: Report): void {
  report.issues ??= []
  const r = report.report
  const usageLists: ImageUsage[][] = [
    r.imageUsages,
    ...Object.values(r.releaseGroupMap),
    ...Object.values(r.workloadGroupMap),
  ]
  for (const usages of usageLists) {
    for (const usage of usages) {
      const vs = usage.versionStatus
      vs.deployedBuiltAt = normalizeBuiltAt(vs.deployedBuiltAt)
      vs.latestBuiltAt = normalizeBuiltAt(vs.latestBuiltAt)
    }
  }
}

async function loadReport(getReport: () => Promise<Report>): Promise<void> {
  useClusterState.setState({ isFetchingReport: true, error: null })
  try {
    const report = await getReport()
    normalizeReport(report)
    useClusterState.setState({
      data: report,
      reportId: report.id,
      lastRefreshed: parseReportDate(report.createdAt),
      isFetchingReport: false,
    })
  } catch (e) {
    useClusterState.setState({ error: String(e), isFetchingReport: false })
  }
}

export function fetchLatestReport(): Promise<void> {
  return loadReport(async () => {
    const clusterName = useClusterState.getState().clusterName
    let url = `${REPORTS_URL}?$limit=1&$sort[createdAt]=-1`
    if (clusterName) url += `&clusterContext=${encodeURIComponent(clusterName)}`
    const json = await fetchJson<ReportsListResponse>(url)
    const report = json.data[0]
    if (!report) throw new Error("No reports found")
    return report
  })
}

export function fetchReport(id: string): Promise<void> {
  return loadReport(() => fetchJson<Report>(`${REPORTS_URL}/${id}`))
}
