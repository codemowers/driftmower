import type { DriftmowerBackendClient } from './client.js'

export const IMAGE_USAGES_PATH = 'image-usages'
export const RELEASE_SCORES_PATH = 'release-scores'

// A ready report never changes: a new analysis writes a new report id. Rows can
// therefore be cached for the lifetime of the process; only the number of
// reports held at once needs a bound. A workload search reads the latest report
// of every cluster on each call, so the bound must comfortably exceed the
// number of clusters or every search re-downloads everything; eviction is
// least-recently-used so the working set stays resident.
const MAXIMUM_CACHED_REPORTS = 16

// The columns this server reads. Selecting them is what keeps a report load
// small: `payload` is most of every row by weight and nothing here reads it.
// The backend only allows `$select` on its query properties, so this list is
// also a statement of which columns it must expose.
const IMAGE_USAGE_SELECTION = [
  'id',
  'reportId',
  'workloadGroupKey',
  'workloadKind',
  'workloadNamespace',
  'workloadName',
  'releaseGroupKey',
  'containerName',
  'registry',
  'repository',
  'deployedTag',
  'latestTag',
  'status',
  'versionStatus'
]

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
      // Re-insert so this report becomes the most recently used.
      this.cache.delete(reportId)
      this.cache.set(reportId, cached)

      return cached
    }

    // The promise is cached rather than its result so concurrent tool calls
    // against the same report share one fetch instead of racing.
    const pending = this.fetch(reportId).catch((error: unknown) => {
      // Only forget this attempt: an evicted-and-reloaded report may already
      // have a healthy entry under the same id.
      if (this.cache.get(reportId) === pending) {
        this.cache.delete(reportId)
      }

      throw error
    })

    this.cache.set(reportId, pending)
    this.evictLeastRecentlyUsed()

    return pending
  }

  private async fetch(reportId: string): Promise<ReportRows> {
    // Both reads are paged, so each is sorted on a key unique within a report
    // — a page boundary must fall in the same place on every request or rows
    // are skipped or seen twice.
    const [imageUsages, releaseScores] = await Promise.all([
      this.client.findAll<ImageUsageRow>(IMAGE_USAGES_PATH, {
        reportId,
        $select: IMAGE_USAGE_SELECTION,
        $sort: { id: 1 }
      }),
      this.client.findAll<ReleaseScoreRow>(RELEASE_SCORES_PATH, { reportId, $sort: { groupKey: 1 } })
    ])

    return {
      imageUsages,
      releaseInfoByGroupKey: new Map(
        releaseScores.map(score => [score.groupKey, toReleaseInfoText(score.releaseInfo)])
      )
    }
  }

  private evictLeastRecentlyUsed(): void {
    while (this.cache.size > MAXIMUM_CACHED_REPORTS) {
      const oldestReportId = this.cache.keys().next().value

      if (oldestReportId === undefined) {
        return
      }

      this.cache.delete(oldestReportId)
    }
  }
}

// The raw release_info text for a Helm release, or null for a row outside any
// release or whose release has no score — the left join the SQL used to do.
export function releaseInfoFor(rows: ReportRows, releaseGroupKey: string | null): string | null {
  if (releaseGroupKey === null) {
    return null
  }

  return rows.releaseInfoByGroupKey.get(releaseGroupKey) ?? null
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
