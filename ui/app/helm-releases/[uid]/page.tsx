"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage } from "@/lib/cluster/reports"
import { useContextHref } from "@/lib/hooks/use-context-href"
import ResourceHeader from "@/app/components/resource-header"
import ChartCard from "./components/chart-card"
import ReleaseTabs from "./components/release-tabs"
import PageLoading from "@/app/components/page-loading"
import HelmInspection from "@/app/components/helm-inspection"

const NO_USAGES: ImageUsage[] = []

export default function HelmReleaseDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const clusterResources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()

  const score = data
    ? Object.values(data.rotenness.releaseScores).find(s => s.releaseInfo.uid === uid)
    : null

  const usages = (data && score ? data.report.releaseGroupMap[score.groupKey] : undefined) ?? NO_USAGES

  if (!data) return <PageLoading loading="release" />

  if (!data || !score) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Release not found</p>
        </Page>
      </div>
    )
  }


  const issueCount = data.issues.filter(i =>
    usages.some(u => u.image.includes(i.image))
  ).length

  const backHref = linkTo("/helm-releases", { drop: ["focus"] })
  const containerLabel = score.totalContainers === 1 ? "1 container" : `${score.totalContainers} containers`
  const workloadLabel = score.totalWorkloadCount === 1 ? "1 workload" : `${score.totalWorkloadCount} workloads`

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <ResourceHeader
          icon={ICONS.helmReleases}
          iconAriaLabel="Helm release"
          title={score.releaseInfo.name}
          copyValue={score.releaseInfo.name}
          breadcrumbs={[
            { label: "Helm Releases", href: backHref },
            { label: `Namespace ${score.releaseInfo.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(score.releaseInfo.namespace)}`) },
            { label: `Release ${score.releaseInfo.name}` },
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
          issueCount={issueCount}
          subtitle={`${containerLabel} · ${workloadLabel}`}
        />

        <ChartCard
          releaseInfo={score.releaseInfo}
          href={linkTo(`/helm-releases/${uid}/chart`, { drop: ["htab", "focus"] })}
        />

        <HelmInspection release={score.releaseInfo} />

        <ReleaseTabs
          releaseInfo={score.releaseInfo}
          usages={usages}
          issues={data.issues}
          clusterResources={clusterResources}
          reportId={reportId}
        />
      </Page>
    </div>
  )
}
