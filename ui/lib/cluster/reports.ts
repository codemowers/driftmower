
export type StatusType = "up_to_date" | "patch_behind" | "minor_behind" | "major_behind" | "ahead" | "behind" | "no_data" | "no_version"

export type ReleaseInfo = {
  desiredVersion?: string
  helmChartRef?: string
  evidence?: string[]
  secretName?: string
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
  finished?: boolean
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
    crawlerSource?: { url: string; version: string }
    sourceStatus?: "linked" | "unlinked" | "unknown"
    sourceRepositories?: { name?: string; url: string }[]
    containerImage?: string
    sbomArtifacts?: string[]
    scannerNamespace?: string
    platforms?: import("@/lib/features/base-images/types").Target[]
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

// Names of the objects a workload uses, as MCP's get_workloads reports them.
export type WorkloadDependencies = {
  pods?: string[]
  images?: string[]
  configmaps?: string[]
  secrets?: string[]
  pvcs?: string[]
  services?: string[]
  ingresses?: string[]
  certificates?: string[]
}

// A generating owner left without its root, and what it still generated.
export type OrphanOwner = WorkloadDependencies & { apiVersion: string; uid: string; ownerReferenceOnly: boolean }

export type ReportWorkload = WorkloadDependencies & {
  sourceRepositories?: import("../features/crawler/sources").SourceRepository[]
  apiVersion?: string
  createdAt?: string
  updatedAt?: string
  updatedBy?: string
  provenance?: Record<string,string>
  ownerReferenceOnly?: boolean
  helmReleaseName?: string
  helmReleaseNamespace?: string
  helmChart?: string
  desiredReplicas?: number
  completed?: boolean
  uid: string
  kind: string
  namespace: string
  name: string
  // On a namespace's orphan bucket (kind Namespace): ownerless Pods, and
  // generating owners by "Kind.group" and name.
  standalonePods?: { name: string; uid: string }[]
  orphaned?: Record<string, Record<string, OrphanOwner>>
}

export type Report = {
  workloads?: ReportWorkload[]
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
