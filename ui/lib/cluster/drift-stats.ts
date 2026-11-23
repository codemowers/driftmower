import type { ImageUsage, StatusType } from "./reports"
import { SEVERITY_ORDER, STALE_STATUSES } from "./styles/status-style.ts"

// Drift of a set of image usages, counting each image repository once at its
// worst status: the score is the stale share of distinct repositories.
export function driftStats(usages: ImageUsage[]) {
  const repoStatus = new Map<string, StatusType>()
  let worstStatus: StatusType = "no_data"
  for (const u of usages) {
    const repo = `${u.imageInfo.registry}/${u.imageInfo.repository}`
    const cur = u.versionStatus.statusType
    const prev = repoStatus.get(repo)
    if (prev === undefined || SEVERITY_ORDER[cur] > SEVERITY_ORDER[prev]) repoStatus.set(repo, cur)
    if (SEVERITY_ORDER[cur] > SEVERITY_ORDER[worstStatus]) worstStatus = cur
  }
  const distinctRepoCount = repoStatus.size
  const staleRepoCount = [...repoStatus.values()].filter(s => STALE_STATUSES.includes(s)).length
  return {
    repoStatus,
    worstStatus,
    distinctRepoCount,
    staleRepoCount,
    normalizedScore: distinctRepoCount > 0 ? staleRepoCount / distinctRepoCount : 0,
  }
}
