"use client"

import { useMemo } from "react"
import { useParams } from "next/navigation"
import { ShipWheel } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage, StatusType } from "@/lib/cluster/reports"
import { SEVERITY_ORDER } from "@/lib/cluster/styles/status-style"
import { normalizeDeployDate } from "@/lib/features/helm-releases/chart-versions"
import { currentChartScopes, deriveActions } from "@/lib/features/actions/derive"
import { useActionAssessments } from "@/lib/features/actions/use-action-assessments"
import { useContextHref } from "@/lib/hooks/use-context-href"
import ResourceHeader from "@/app/components/resource-header"
import ActionsCard from "@/app/components/actions-card"
import ReleaseStats from "./components/release-stats"
import ChartCard from "./components/chart-card"
import ReleaseTabs from "./components/release-tabs"
import PageLoading from "@/app/components/page-loading"

const NO_USAGES: ImageUsage[] = []

export default function HelmReleaseDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const clusterResources = useClusterState(s => s.clusterResources)
  const vulnerabilityReports = useClusterState(s => s.vulnerabilityReports)
  const { linkTo } = useContextHref()

  const score = data
    ? Object.values(data.rotenness.releaseScores).find(s => s.releaseInfo.uid === uid)
    : null

  const usages = (data && score ? data.report.releaseGroupMap[score.groupKey] : undefined) ?? NO_USAGES
  const actionRows = useMemo(() => deriveActions(usages, undefined, vulnerabilityReports), [usages, vulnerabilityReports])
  const currentCharts = useMemo(() => currentChartScopes(usages), [usages])
  const assessments = useActionAssessments(actionRows, currentCharts)

  if (!data) return <PageLoading loading="release" />

  if (!data || !score) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Release not found</p>
        </main>
      </div>
    )
  }

  const normalizedScore = score.distinctRepoCount > 0 ? score.staleRepoCount / score.distinctRepoCount : 0

  const worstStatus = usages.reduce<StatusType>((worst, u) => {
    const s = u.versionStatus.statusType
    return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
  }, "no_data")

  const issueCount = data.issues.filter(i =>
    usages.some(u => u.image.includes(i.image))
  ).length

  const backHref = linkTo("/helm-releases", { drop: ["focus"] })
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
          chips={[
            { label: score.releaseInfo.managementKind, tone: "brand" },
            ...(score.releaseInfo.helmStatus
              ? [{
                  label: score.releaseInfo.helmStatus,
                  className: score.releaseInfo.helmStatus === "deployed"
                    ? "bg-status-ok-bg text-status-ok-label"
                    : "bg-status-minor-bg text-status-minor-label",
                }]
              : []),
          ]}
          scoreChip={{ status: worstStatus, score: normalizedScore }}
          issueCount={issueCount}
          subtitle={`${score.releaseInfo.namespace} · ${containerLabel} · ${workloadLabel}`}
        />

        <ReleaseStats
          normalizedScore={normalizedScore}
          staleRepoCount={score.staleRepoCount}
          distinctRepoCount={score.distinctRepoCount}
          namespace={score.releaseInfo.namespace}
          worstStatus={worstStatus}
          installedAt={normalizeDeployDate(score.releaseInfo.firstDeployedAt)}
          upgradedAt={normalizeDeployDate(score.releaseInfo.lastDeployedAt)}
          revision={score.releaseInfo.revision}
        />

        <ChartCard
          releaseInfo={score.releaseInfo}
          href={linkTo(`/helm-releases/${uid}/chart`, { drop: ["htab", "focus"] })}
        />

        <ActionsCard {...assessments} />

        <ReleaseTabs
          uid={uid}
          releaseInfo={score.releaseInfo}
          usages={usages}
          issues={data.issues}
          clusterResources={clusterResources}
          reportId={reportId}
        />
      </main>
    </div>
  )
}
