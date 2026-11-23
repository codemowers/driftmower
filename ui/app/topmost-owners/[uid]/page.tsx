"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { collectOwnedPods, findWorkloadRoot } from "@/lib/cluster/workload-root"
import { classifyPod } from "@/lib/cluster/styles/pod-status-style"
import { driftStats } from "@/lib/cluster/drift-stats"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { workloadMetricQueries } from "@/lib/features/prometheus/workload-metrics"
import ResourceHeader, { type Chip } from "@/app/components/resource-header"
import PrometheusResourceUsageCard from "@/app/components/prometheus-resource-usage-card"
import WorkloadStats from "./components/workload-stats"
import DetailLayout from "@/app/components/layout/detail-layout"
import ScopeFindings from "@/app/components/findings/scope-findings"
import AlertsCard from "@/app/components/findings/alerts-card"
import VolumesCard from "@/app/components/scope/volumes-card"
import { aggregateIssues } from "@/lib/cluster/scope"
import ManagerCard from "./components/manager-card"
import ProvenanceCard from "./components/provenance-card"
import { WorkloadNav } from "@/app/components/layout/resource-navs"
import CommandsCard from "./components/commands-card"
import WorkloadTabs from "./components/workload-tabs"
import ImagesCard from "@/app/components/scope/images-card"
import PodsCard from "@/app/components/scope/pods-card"
import RestartTile, { type RestartTarget } from "@/app/components/restart-tile"
import { useFeatureFlags } from "@/app/components/feature-flags-init"
import { useWorkloadMetrics } from "./hooks/use-workload-metrics"
import PageLoading from "@/app/components/page-loading"
import OrphanBucket from "./components/orphan-bucket"

const RESTARTABLE_KINDS = new Set(["Deployment", "StatefulSet"])

// Orphan buckets have UIDs "namespace:<name>"; every other UID is a workload root.
export default function WorkloadPage() {
  const { uid } = useParams<{ uid: string }>()
  return uid.startsWith("namespace:") ? <OrphanBucket uid={uid} /> : <WorkloadDetailPage />
}

function WorkloadDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const clusterResources = useClusterState(s => s.clusterResources)
  const restartEnabled = useFeatureFlags(s => s.workloadRestart)
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
  const ownedPods = clusterResources && root ? collectOwnedPods(clusterResources, root.uid) : []
  // Completed and failed Pods no longer run anything.
  const livePods = ownedPods.filter(p => !["succeeded", "failed"].includes(classifyPod(p)))
  const livePodNames = livePods.map(p => p.name)
  const reportPodNames = match ? [...new Set(match[1].map(u => u.podName))] : []
  const podNames = livePodNames.length > 0 ? livePodNames : reportPodNames
  const workloadMetrics = useWorkloadMetrics(namespace, root?.uid ?? uid, podNames)

  if (!data) return <PageLoading loading="workload" />

  if (!data || !match) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Workload not found</p>
        </Page>
      </div>
    )
  }

  const [, usages] = match

  const { staleRepoCount, distinctRepoCount } = driftStats(usages)

  const resourceIssues = root?.issues ?? aggregateIssues(livePods)
  const issueCount = data.issues.filter(i =>
    usages.some(u => u.image.includes(i.image))
  ).length

  const finished = new Set(ownedPods.filter(p => !livePods.includes(p)).map(p => p.name))
  const running = usages.filter(u => !finished.has(u.podName))
  const totalContainers = running.length
  const totalPods = new Set(running.map(u => u.podName)).size

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
    restartEnabled && root && !root.ownerUID && root.apiVersion && RESTARTABLE_KINDS.has(root.kind)
      ? { kind: root.kind, apiVersion: root.apiVersion, namespace: root.namespace, name: root.name, uid: root.uid, managerKind: root.argoApp ? "argo" : "standalone" }
      : null
  const containerLabel = totalContainers === 1 ? "1 container" : `${totalContainers} containers`
  const podLabel = totalPods === 1 ? "1 pod" : `${totalPods} pods`
  const headerChips: Chip[] = [{ label: kind, tone: "brand" }]
  if (!isHelm && !isArgo) headerChips.push({ label: "standalone", tone: "muted" })

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <ResourceHeader
          icon={ICONS.workloads}
          iconAriaLabel="Workload"
          title={name}
          copyValue={name}
          breadcrumbs={[
            { label: "Workloads", href: backHref },
            { label: `Namespace ${namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(namespace)}`) },
            { label: `${kindLabel} ${name}` },
          ]}
          chips={headerChips}
          issueCount={issueCount + resourceIssues.length}
          subtitle={`${namespace} · ${containerLabel} · ${podLabel}`}
        />
        <WorkloadNav uid={uid} namespace={namespace} podNames={podNames} />

        <DetailLayout
          main={<>
            <CommandsCard kind={kind} namespace={namespace} name={name} apiGroup={root?.apiVersion ?? rootInfo?.apiGroup} />
            <AlertsCard scope={{ namespace, pods: podNames }} hideWhenEmpty />
            <ScopeFindings scope={{ kind: "workload", uid }} resourceIssues={resourceIssues} />
            {isHelm && ri && releaseUid ? (
              <ManagerCard kind="helm" releaseInfo={ri} releaseUid={releaseUid} reportId={reportId} />
            ) : isArgo && argoApp ? (
              <ManagerCard kind="argo" appName={argoApp.name} url={argoApp.url} resourceKind={argoApp.kind} resourceRef={argoApp.resourceRef} />
            ) : null}
            <ImagesCard usages={running} livenessProbes={[...new Map(livePods.flatMap(p => p.livenessProbes ?? []).map(p => [`${p.container}::${p.check}`, p])).values()]} />
            <PodsCard pods={clusterResources ? ownedPods : null} workloadUid={uid} />
            <VolumesCard namespace={namespace} pods={podNames} operator={{ kind, apiVersion: root?.apiVersion ?? rootInfo?.apiGroup, name }} />
            <WorkloadTabs usages={usages} clusterResources={clusterResources} reportWorkloadUid={uid} liveWorkloadUid={liveWorkloadUid} />
          </>}
          aside={<>
            <WorkloadStats
              staleRepoCount={staleRepoCount}
              distinctRepoCount={distinctRepoCount}
              totalContainers={totalContainers}
              totalPods={totalPods}
              provenance={root ? <ProvenanceCard root={root} embedded /> : undefined}
            />
            <PrometheusResourceUsageCard
              metrics={workloadMetrics}
              graphQueries={workloadMetricQueries(namespace, podNames)}
              podCount={podNames.length}
              qosBreakdown={workloadMetrics?.qosBreakdown}
              vertical
            />
            {restartTarget && <RestartTile target={restartTarget} restartedAt={root?.restartedAt ?? null} pods={livePods} />}
          </>}
        />
      </Page>
    </div>
  )
}
