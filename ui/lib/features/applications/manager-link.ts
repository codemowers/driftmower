import type { ReleaseScore } from "@/lib/cluster/reports"
import type { ApplicationEntry, ManagerLink } from "./types"

const HELM_PREFIX = "helm-release:"

// The release uid exists only in the report, so one it has not seen resolves to null.
export function resolveManagerLink(
  entry: ApplicationEntry,
  releaseScores: Record<string, ReleaseScore> | undefined,
): ManagerLink | null {
  if (entry.managerUID?.startsWith(HELM_PREFIX)) {
    const [namespace, ...rest] = entry.managerUID.slice(HELM_PREFIX.length).split(":")
    const release = rest.join(":")
    if (!namespace || !release) return null

    const info = releaseScores
      ? Object.values(releaseScores).find(
        s => s.releaseInfo.name === release && s.releaseInfo.namespace === namespace,
      )?.releaseInfo
      : undefined

    return {
      kind: "helm",
      release,
      namespace,
      uid: info?.uid ?? null,
      chartName: info?.chartName ?? "",
      chartVersion: info?.chartSourceVersion ?? info?.chartVersion ?? "",
      chartAppVersion: info?.chartAppVersion ?? "",
      latestChartTag: info?.latestChartTag,
    }
  }

  if (entry.argoApp) {
    return { kind: "argo", name: entry.argoApp.name, url: entry.argoApp.url }
  }

  return null
}
