"use client"

import { useParams } from "next/navigation"
import { ShipWheel } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import { useContextHref } from "@/lib/hooks/use-context-href"
import ResourceHeader from "@/app/components/resource-header"
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
  const clusterResources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()

  const score = data
    ? Object.values(data.rotenness.releaseScores).find(s => s.releaseInfo.uid === uid)
    : null

  if (!data || !score) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Release not found</p>
        </main>
      </div>
    )
  }

  const usages = data.report.releaseGroupMap[score.groupKey] ?? []

  const normalizedScore = score.distinctRepoCount > 0 ? score.staleRepoCount / score.distinctRepoCount : 0

  const worstStatus = usages.reduce<StatusType>((worst, u) => {
    const s = u.versionStatus.statusType
    return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
  }, "no_data")

  const issueCount = data.issues.filter(i =>
    usages.some(u => u.image.includes(i.image))
  ).length

  const backHref = linkTo("/helm-releases")
  const containerLabel = score.totalContainers === 1 ? "1 container" : `${score.totalContainers} containers`
  const workloadLabel = score.totalWorkloadCount === 1 ? "1 workload" : `${score.totalWorkloadCount} workloads`

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={ShipWheel}
          iconAriaLabel="Helm release"
          title={score.releaseInfo.name}
          copyValue={score.releaseInfo.name}
          breadcrumbs={[
            { label: "Helm Releases", href: backHref },
            { label: `${score.releaseInfo.managementKind} ${score.releaseInfo.name}` },
          ]}
          chips={[{ label: score.releaseInfo.managementKind, tone: "brand" }]}
          scoreChip={{ status: worstStatus, score: normalizedScore }}
          issueCount={issueCount}
          subtitle={`${score.releaseInfo.namespace} · ${containerLabel} · ${workloadLabel}`}
        />

        <ReleaseStats
          normalizedScore={normalizedScore}
          staleRepoCount={score.staleRepoCount}
          distinctRepoCount={score.distinctRepoCount}
          totalContainers={score.totalContainers}
          totalWorkloadCount={score.totalWorkloadCount}
          namespace={score.releaseInfo.namespace}
          worstStatus={worstStatus}
        />

        <ChartCard releaseInfo={score.releaseInfo} />

        <ReleaseTabs usages={usages} issues={data.issues} clusterResources={clusterResources} releaseInfo={score.releaseInfo} reportId={reportId} />
      </main>
    </div>
  )
}
