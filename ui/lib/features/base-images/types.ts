// Field names mirror internal/registry's API and MCP responses.
export type Platform = { os: string; architecture: string; variant?: string }
export type Layer = { digest: string; diffID?: string; mediaType?: string; size: number }
export type Target = { digest: string; platform: Platform; layers: Layer[] }
export type BaseImage = Omit<Target, "layers"> & {
  layers?: Target["layers"]
  layerCount?: number
  repository: string
  configDigest: string
  tags: string[]
  currentTags: string[]
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created?: string
  entrypoint?: string[]
  cmd?: string[]
  workingDir?: string
  user?: string
  fetchedAt: string
}
export type RepositorySummary = {
  repository: string
  tagPattern: string
  checkedAt?: string
  nextCrawl?: string
  listedTags: number
  matchedTags: number
  imageCount: number
  skippedTags?: number
  errors?: string[]
}
export type RegistryStatus = {
  registry: string
  state: "idle" | "scraping" | "throttled"
  activeRepositories: string[]
  authentication: "anonymous" | "authenticated"
  retryAt?: string
  lastRequest?: string
  lastSuccess?: string
  lastError?: string
  lastHTTPStatus?: number
}
export type RepositoryDetail = RepositorySummary & { images: BaseImage[] }
export type Candidate = Pick<BaseImage, "repository" | "digest" | "tags" | "platform" | "created"> & { evidence: string }
export type Hierarchy = {
  digest: string
  platform: Platform
  layerCount: number
  root: string
  stages: { layerCount: number; candidates: Candidate[]; truncated: boolean }[]
}
export type HierarchyResult = { hierarchies: Hierarchy[]; warnings?: string[] }

export function preferredTag(tags: string[]): string {
  const exact = tags.filter(tag => /^v?\d+\.\d+\.\d+/.test(tag))
  return [...(exact.length ? exact : tags)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? "untagged"
}

export function platformName(platform: Platform): string {
  return [platform.os, platform.architecture, platform.variant].filter(Boolean).join("/")
}
