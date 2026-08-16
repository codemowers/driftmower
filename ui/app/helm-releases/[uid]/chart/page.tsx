"use client"

import { useParams } from "next/navigation"
import { Map } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { chartDrift, cleanChartTags, newestPatchOfMinor, normalizeChartVersion, normalizeDeployDate, stableVersionsBetween } from "@/app/helm-releases/utils/chart-versions"
import { SEVERITY_STYLE, isNoData } from "@/lib/cluster/status-style"
import ResourceHeader from "@/app/components/resource-header"
import ChartStats from "./components/chart-stats"
import ChartSourceCard from "./components/chart-source-card"
import ChartCommandsCard, { canBuildChartCommands } from "./components/chart-commands-card"
import ContainersCard from "./components/containers-card"
import UsedByCard, { chartIdentity } from "./components/used-by-card"
import VersionHistoryCard from "./components/version-history-card"

function repoHost(url?: string): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export default function ChartDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
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

  const info = score.releaseInfo
  const chartName = info.chartName ?? info.name
  const deployed = info.chartSourceVersion ?? normalizeChartVersion(info.chartVersion)
  const drift = chartDrift(deployed, info.latestChartTag)
  const driftStyle = SEVERITY_STYLE[drift]
  const { stable, prerelease } = cleanChartTags(info.chartTags ?? [])
  const behindCount = stableVersionsBetween(stable, deployed, info.latestChartTag)
  const patchUpdate = newestPatchOfMinor(stable, deployed)

  const usages = data.report.releaseGroupMap[score.groupKey] ?? []
  const usedByReleases = Object.values(data.rotenness.releaseScores).filter(
    s => chartIdentity(s.releaseInfo) === chartIdentity(info),
  )

  const subtitle =
    info.chartSourceKind === "helm-repo"
      ? [repoHost(info.chartRepoUrl), info.chartSource].filter(Boolean).join(" · ")
      : info.chartRegistry && info.chartRepository
        ? `${info.chartRegistry}/${info.chartRepository}`
        : ""

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Map}
          iconAriaLabel="Helm chart"
          title={chartName}
          copyValue={chartName}
          breadcrumbs={[
            { label: "Helm Releases", href: linkTo("/helm-releases", { drop: ["focus"] }) },
            {
              label: `${info.managementKind} ${info.name}`,
              href: linkTo(`/helm-releases/${uid}`, { drop: ["htab", "focus"] }),
            },
            { label: `chart ${chartName}` },
          ]}
          chips={info.chartSourceKind ? [{ label: info.chartSourceKind, tone: "muted" }] : []}
          scoreChip={!isNoData(drift) && driftStyle ? { status: drift, score: 0, label: driftStyle.label } : null}
          subtitle={subtitle}
        />

        <ChartStats
          deployed={deployed}
          latest={info.latestChartTag}
          appVersion={info.chartAppVersion}
          revision={info.revision}
          drift={drift}
          behindCount={behindCount}
          patchUpdate={patchUpdate}
          hasTags={stable.length > 0}
          helmStatus={info.helmStatus}
          installedAt={normalizeDeployDate(info.firstDeployedAt)}
          upgradedAt={normalizeDeployDate(info.lastDeployedAt)}
        />

        <div className="grid gap-6 md:grid-cols-5">
          <div className="flex flex-col gap-6 md:col-span-3">
            <ContainersCard usages={usages} reportId={reportId} />
            {info.chartSource && canBuildChartCommands(info.chartSource, info.chartRepoUrl) && (
              <ChartCommandsCard
                chartSource={info.chartSource}
                repoUrl={info.chartRepoUrl}
                version={info.chartSourceVersion}
              />
            )}
          </div>
          <div className="flex flex-col gap-6 md:col-span-2">
            <UsedByCard releases={usedByReleases} linkTo={linkTo} />
            <ChartSourceCard releaseInfo={info} />
          </div>
        </div>

        <VersionHistoryCard
          stable={stable}
          prerelease={prerelease}
          deployed={deployed}
          latest={info.latestChartTag}
          releaseName={info.name}
          namespace={info.namespace}
          chartSource={info.chartSource}
          repoUrl={info.chartRepoUrl}
        />
      </main>
    </div>
  )
}
