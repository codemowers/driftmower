"use client"

import { useParams } from "next/navigation"
import { Boxes } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { collectOwnedPods, findWorkloadRoot } from "@/lib/cluster/workload-root"
import type { ImageUsage, StatusType } from "@/lib/cluster/reports"
import { SEVERITY_ORDER, STALE_STATUSES } from "@/lib/cluster/styles/status-style"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { workloadMetricQueries } from "@/lib/features/prometheus/workload-metrics"
import ResourceHeader from "@/app/components/resource-header"
import PrometheusResourceUsageCard from "@/app/components/prometheus-resource-usage-card"
import WorkloadStats from "./components/workload-stats"
import ManagerCard from "./components/manager-card"
import NetworkCard from "@/app/components/network-card"
import AiInsightsCard from "./components/ai-insights-card"
import CommandsCard from "./components/commands-card"
import WorkloadTabs from "./components/workload-tabs"
import ActionsCard from "@/app/components/actions-card"
import LivenessProbeCard from "@/app/components/liveness-probe-card"
import RestartTile, { type RestartTarget } from "@/app/components/restart-tile"
import { useFeatureFlags } from "@/app/components/feature-flags-init"
import { useWorkloadMetrics } from "./hooks/use-workload-metrics"
import { useActionAssessments } from "@/lib/features/actions/use-action-assessments"
import { currentChartScopes, deriveActions } from "@/lib/features/actions/derive"
import PageLoading from "@/app/components/page-loading"

const NO_USAGES: ImageUsage[] = []
const RESTARTABLE_KINDS = new Set(["Deployment", "StatefulSet"])

export default function WorkloadDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const clusterResources = useClusterState(s => s.clusterResources)
  const restartEnabled = useFeatureFlags(s => s.workloadRestart)
  const vulnerabilityReports = useClusterState(s => s.vulnerabilityReports)
  const { linkTo } = useContextHref()

  const match = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === uid,
      )
    : undefined

  const rootInfo = match?.[1][0]?.workloadRootInfo
  const kind = rootInfo?.kind ?? ""
  const namespace = rootInfo?.namespace ?? ""
  const name = rootInfo?.name ?? ""
  const kindLabel = rootInfo?.qualifiedKind ?? kind
  const root = findWorkloadRoot(clusterResources, { uid, kind, name, namespace })
  const livePods = clusterResources && root ? collectOwnedPods(clusterResources, root.uid) : []
  const livePodNames = livePods.map(p => p.name)
  const reportPodNames = match ? [...new Set(match[1].map(u => u.podName))] : []
  const podNames = livePodNames.length > 0 ? livePodNames : reportPodNames
  const workloadMetrics = useWorkloadMetrics(namespace, podNames)
  const actionUsages = match?.[1] ?? NO_USAGES
  const actionRows = deriveActions(actionUsages, root, vulnerabilityReports)
  const currentCharts = currentChartScopes(actionUsages)
  const assessments = useActionAssessments(actionRows, currentCharts)

  if (!data) return <PageLoading loading="workload" />

  if (!data || !match) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Workload not found</p>
        </main>
      </div>
    )
  }

  const [groupKey, usages] = match

  const repoStatus = new Map<string, StatusType>()
  for (const u of usages) {
    const repo = `${u.imageInfo.registry}/${u.imageInfo.repository}`
    const prev = repoStatus.get(repo)
    const cur = u.versionStatus.statusType
    if (prev === undefined || SEVERITY_ORDER[cur] > SEVERITY_ORDER[prev]) {
      repoStatus.set(repo, cur)
    }
  }
  const distinctRepoCount = repoStatus.size
  const staleRepoCount = Array.from(repoStatus.values()).filter(s => STALE_STATUSES.includes(s)).length
  const normalizedScore = distinctRepoCount > 0 ? staleRepoCount / distinctRepoCount : 0

  const worstStatus = usages.reduce<StatusType>((worst, u) => {
    const s = u.versionStatus.statusType
    return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
  }, "no_data")

  const issueCount = data.issues.filter(i =>
    usages.some(u => u.image.includes(i.image))
  ).length

  const totalContainers = usages.length
  const totalPods = new Set(usages.map(u => u.podName)).size

  const ri = usages[0]?.releaseInfo
  const releaseUid = ri
    ? Object.values(data.rotenness.releaseScores).find(s => s.releaseInfo.groupKey === ri.groupKey)?.releaseInfo.uid
    : undefined
  const isHelm = ri?.managementKind === "helm" && releaseUid

  const backHref = linkTo("/topmost-owners")
  const argoApp = root?.argoApp
  const isArgo = !isHelm && !!argoApp
  const liveWorkloadUid = root?.uid ?? uid
  const restartTarget: RestartTarget | null =
    restartEnabled && root && !root.ownerUID && RESTARTABLE_KINDS.has(root.kind)
      ? { kind: root.kind, namespace: root.namespace, name: root.name, uid: root.uid, managerKind: root.argoApp ? "argo" : "standalone" }
      : null
  const containerLabel = totalContainers === 1 ? "1 container" : `${totalContainers} containers`
  const podLabel = totalPods === 1 ? "1 pod" : `${totalPods} pods`
  const headerChips: { label: string; tone?: "brand" | "muted" }[] = [{ label: kind, tone: "brand" }]
  if (!isHelm && !isArgo) headerChips.push({ label: "standalone", tone: "muted" })

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Boxes}
          iconAriaLabel="Workload"
          title={name}
          copyValue={name}
          breadcrumbs={[
            { label: "Workloads", href: backHref },
            { label: `Namespace ${namespace}` },
            { label: `${kindLabel} ${name}` },
          ]}
          chips={headerChips}
          scoreChip={{ status: worstStatus, score: normalizedScore }}
          issueCount={issueCount}
          subtitle={`${namespace} · ${containerLabel} · ${podLabel}`}
        />

        <WorkloadStats
          normalizedScore={normalizedScore}
          staleRepoCount={staleRepoCount}
          distinctRepoCount={distinctRepoCount}
          totalContainers={totalContainers}
          totalPods={totalPods}
          namespace={namespace}
          worstStatus={worstStatus}
        />

        {isHelm && ri && releaseUid ? (
          <ManagerCard kind="helm" releaseInfo={ri} releaseUid={releaseUid} reportId={reportId} />
        ) : isArgo && argoApp ? (
          <ManagerCard kind="argo" appName={argoApp.name} url={argoApp.url} resourceKind={argoApp.kind} resourceRef={argoApp.resourceRef} />
        ) : null}

        <LivenessProbeCard probes={livePods.flatMap(p => p.livenessProbes ?? [])} />

        <ActionsCard {...assessments} />

        <AiInsightsCard key={`${groupKey}:${reportId}`} workloadKey={groupKey} reportId={reportId} />

        <PrometheusResourceUsageCard
          metrics={workloadMetrics}
          graphQueries={workloadMetricQueries(namespace, podNames)}
          podCount={podNames.length}
          perPod={workloadMetrics?.perPod}
          qosBreakdown={workloadMetrics?.qosBreakdown}
          podHref={podName => {
            const podRes = clusterResources?.find(r => r.kind === "Pod" && r.name === podName && r.namespace === namespace)
            return podRes ? linkTo(`/topmost-owners/${uid}/${podRes.uid}`, { drop: ["ptab"] }) : null
          }}
        />

        <div className={cn("grid grid-cols-1 items-start gap-6", restartTarget ? "md:grid-cols-[2.5fr_2fr_auto]" : "md:grid-cols-[3fr_2fr]")}>
          <CommandsCard kind={kind} namespace={namespace} name={name} apiGroup={rootInfo?.apiGroup} />
          <NetworkCard href={linkTo(`/topmost-owners/${uid}/network-topology`)} />
          {restartTarget && <RestartTile target={restartTarget} restartedAt={root?.restartedAt ?? null} pods={livePods} />}
        </div>

        <WorkloadTabs usages={usages} issues={data.issues} clusterResources={clusterResources} reportWorkloadUid={uid} liveWorkloadUid={liveWorkloadUid} />
      </main>
    </div>
  )
}
