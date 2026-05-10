"use client"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import ReleaseHeader from "./components/release-header"
import ReleaseStats from "./components/release-stats"
import ChartCard from "./components/chart-card"
import ReleaseTabs from "./components/release-tabs"

const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 4,
  minor_behind:  3,
  patch_behind:  2,
  up_to_date:    1,
  ahead:         0,
  no_data:      -1,
  no_version:   -1,
}

export default function HelmReleaseDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const explorerResources = useClusterState(s => s.explorerResources)

  const score = data
    ? Object.values(data.rotenness.releaseScores).find(s => s.releaseInfo.uid === uid)
    : null

  const usages = score ? (data!.report.releaseGroupMap[score.groupKey] ?? []) : []

  const worstStatus = usages.reduce<StatusType>((worst, u) => {
    const s = u.versionStatus.statusType
    return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
  }, "no_data")

  const issueCount = data?.issues.filter(i =>
    usages.some(u => u.image.includes(i.image))
  ).length ?? 0

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        {score ? (
          <>
            <ReleaseHeader
              releaseInfo={score.releaseInfo}
              normalizedScore={score.normalizedScore}
              totalContainers={score.totalContainers}
              totalWorkloadCount={score.totalWorkloadCount}
              worstStatus={worstStatus}
              issueCount={issueCount}
              reportId={reportId}
            />

            <ReleaseStats
              normalizedScore={score.normalizedScore}
              staleRepoCount={score.staleRepoCount}
              distinctRepoCount={score.distinctRepoCount}
              totalContainers={score.totalContainers}
              totalWorkloadCount={score.totalWorkloadCount}
              namespace={score.releaseInfo.namespace}
              worstStatus={worstStatus}
            />

            <ChartCard releaseInfo={score.releaseInfo} />

            <ReleaseTabs usages={usages} issues={data!.issues} explorerResources={explorerResources} releaseInfo={score.releaseInfo} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Release not found</p>
        )}
      </main>
    </div>
  )
}
