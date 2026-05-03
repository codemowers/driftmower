"use client"

import PageHeader from "../components/page-header"
import ReleaseList, { type ReleaseEntry } from "./components/release-list"
import ReleaseSummary from "./components/release-summary"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"

const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 4,
  minor_behind:  3,
  patch_behind:  2,
  up_to_date:    1,
  ahead:         0,
  no_data:      -1,
  no_version:   -1,
}

export default function HelmReleasesPage() {
  const { data } = useClusterState()

  const entries: ReleaseEntry[] = data
    ? Object.values(data.rotenness.releaseScores).map(score => {
        const usages = data.report.releaseGroupMap[score.groupKey] ?? []

        const worstStatus = usages.reduce<StatusType>((worst, u) => {
          const s = u.versionStatus.statusType
          return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
        }, "no_data")

        const issueCount = data.issues.filter(i =>
          usages.some(u => u.image.includes(i.image))
        ).length

        return {
          groupKey: score.groupKey,
          releaseInfo: score.releaseInfo,
          normalizedScore: score.normalizedScore,
          staleRepoCount: score.staleRepoCount,
          distinctRepoCount: score.distinctRepoCount,
          totalContainers: score.totalContainers,
          totalWorkloadCount: score.totalWorkloadCount,
          worstStatus,
          issueCount,
        }
      })
      .sort((a, b) => b.normalizedScore - a.normalizedScore)
    : []

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Helm Releases" subtitle="Installed charts and revision history" />
        <ReleaseSummary entries={entries} />
        <ReleaseList entries={entries} />
      </main>
    </div>
  )
}
