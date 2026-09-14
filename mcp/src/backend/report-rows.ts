import type { DriftmowerBackendClient } from './client.js'

export const IMAGE_USAGES_PATH = 'image-usages'
export const RELEASE_SCORES_PATH = 'release-scores'

// A ready report never changes: a new analysis writes a new report id. Rows can
// therefore be cached for the lifetime of the process; only the number of
// reports held at once needs a bound.
const MAXIMUM_CACHED_REPORTS = 4

export interface ImageUsageRow {
  reportId: string
  workloadGroupKey: string
  workloadKind: string | null
  workloadNamespace: string | null
  workloadName: string | null
  releaseGroupKey: string | null
  containerName: string | null
  registry: string
  repository: string
  deployedTag: string | null
  latestTag: string | null
  status: string
  versionStatus: string | null
}

export interface ReportRows {
  imageUsages: ImageUsageRow[]
  // Raw `release_info` JSON text keyed by release group key, matching what the
  // SQL join used to hand downstream code.
  releaseInfoByGroupKey: Map<string, string | null>
}

interface ReleaseScoreRow {
  reportId: string
  groupKey: string
  releaseInfo: unknown
}

export class ReportRowLoader {
  private readonly cache = new Map<string, Promise<ReportRows>>()

  constructor(private readonly client: DriftmowerBackendClient) {}

  load(reportId: string): Promise<ReportRows> {
    const cached = this.cache.get(reportId)

    if (cached) {
      return cached
    }

    // The promise is cached rather than its result so concurrent tool calls
    // against the same report share one fetch instead of racing.
    const pending = this.fetch(reportId).catch((error: unknown) => {
      this.cache.delete(reportId)

      throw error
    })

    this.cache.set(reportId, pending)
    this.evictOldestReports()

    return pending
  }

  private async fetch(reportId: string): Promise<ReportRows> {
    const [imageUsages, releaseScores] = await Promise.all([
      this.client.findAll<ImageUsageRow>(IMAGE_USAGES_PATH, { reportId }),
      this.client.findAll<ReleaseScoreRow>(RELEASE_SCORES_PATH, { reportId })
    ])

    return {
      imageUsages,
      releaseInfoByGroupKey: new Map(
        releaseScores.map(score => [score.groupKey, toReleaseInfoText(score.releaseInfo)])
      )
    }
  }

  private evictOldestReports(): void {
    while (this.cache.size > MAXIMUM_CACHED_REPORTS) {
      const oldestReportId = this.cache.keys().next().value

      if (oldestReportId === undefined) {
        return
      }

      this.cache.delete(oldestReportId)
    }
  }
}

// The backend stores release_info as JSON text and returns it unresolved, but
// tolerate an object in case a future resolver parses it: everything
// downstream parses this with parseReleaseInfo.
function toReleaseInfoText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}
