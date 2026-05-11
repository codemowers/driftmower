import { useClusterState } from "./cluster-state"
import { REPORTS_URL } from "./constants"

export type StatusType = "up_to_date" | "patch_behind" | "minor_behind" | "major_behind" | "ahead" | "no_data" | "no_version"

export type ReleaseInfo = {
  managementKind: string
  name: string
  namespace: string
  uid: string
  groupKey: string
  chartName: string
  chartVersion: string
  chartAppVersion: string
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

export type ImageUsage = {
  namespace: string
  podName: string
  containerName: string
  image: string
  actualTag: string
  imageInfo: {
    registry: string
    repository: string
    tag: string
    digest: string
    repositoryUrl?: string
    tagUrl?: string
  }
  versionStatus: {
    statusType: StatusType
    deployedTag: string | null
    latestTag: string | null
    majorDifference: number
    minorDifference: number
    patchDifference: number
    deployedBuiltAt?: string                           // ISO 8601, when present
    latestBuiltAt?: string                             // ISO 8601, when present
  }
  workloadRootInfo: {
    kind: string
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
  reportHash: string
  previousReportId: string | null
  report: {
    imageUsages: ImageUsage[]
    releaseGroupMap: Record<string, ImageUsage[]>
    workloadGroupMap: Record<string, ImageUsage[]>
    registryRepoMap: Record<string, unknown>
    excludedContainerCount: number
  }
  rotenness: {
    normalizedScore: number
    totalContainers: number
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

export async function fetchLatestReport(): Promise<void> {
  useClusterState.setState({ isFetchingReport: true, error: null })
  try {
    const clusterName = useClusterState.getState().clusterName
    const res = await fetch(
      `${REPORTS_URL}?$limit=1&$sort[createdAt]=-1&clusterContext=${clusterName}`,
    )
    if (!res.ok) throw new Error(`Failed to fetch reports: ${res.status}`)
    const json: ReportsListResponse = await res.json()
    const report = json.data[0]
    if (!report) throw new Error("No reports found")
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

export async function fetchReport(id: string): Promise<void> {
  useClusterState.setState({ isFetchingReport: true, error: null })
  try {
    const res = await fetch(`${REPORTS_URL}/${id}`)
    if (!res.ok) throw new Error(`Failed to fetch report: ${res.status}`)
    const report: Report = await res.json()
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
