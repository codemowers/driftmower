"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage } from "@/lib/cluster/reports"
import { STALE_STATUSES } from "@/lib/cluster/styles/status-style"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { podMetricQueries } from "@/lib/features/prometheus/pod-metrics"
import ResourceHeader from "@/app/components/resource-header"
import { PodNav } from "@/app/components/layout/resource-navs"
import PrometheusResourceUsageCard from "@/app/components/prometheus-resource-usage-card"
import CommandsCard from "./components/commands-card"
import PodStats from "./components/pod-stats"
import DetailLayout from "@/app/components/layout/detail-layout"
import ScopeFindings from "@/app/components/findings/scope-findings"
import AlertsCard from "@/app/components/findings/alerts-card"
import PodTabs from "./components/pod-tabs"
import ImagesCard from "@/app/components/scope/images-card"
import VolumesCard from "@/app/components/scope/volumes-card"
import { usePodMetrics } from "./hooks/use-pod-metrics"
import PodShellAccess from "@/app/components/pod-shell-access"
import DeletePodAction from "@/app/components/delete-pod-action"
import { useFeatureFlags } from "@/app/components/feature-flags-init"
import PageLoading from "@/app/components/page-loading"

export default function PodDetailPage() {
  const { uid: workloadUid, podUid } = useParams<{ uid: string; podUid: string }>()
  const restartEnabled = useFeatureFlags(s => s.workloadRestart)
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()

  const pod = clusterResources?.find(r => r.uid === podUid && r.kind === "Pod") ?? null
  const podMetrics = usePodMetrics(pod?.namespace ?? "", workloadUid, pod?.name ?? "")

  const workloadMatch = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === workloadUid,
      )
    : undefined

  if (!data) return <PageLoading loading="pod" />

  if (!data || !pod || !workloadMatch) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Pod not found</p>
        </Page>
      </div>
    )
  }

  const [, workloadUsages] = workloadMatch
  const workloadRoot = workloadUsages[0]?.workloadRootInfo
  const workloadName = workloadRoot?.name ?? "—"
  const workloadKind = workloadRoot?.qualifiedKind ?? workloadRoot?.kind ?? "—"

  const ownUsages = data.report.imageUsages.filter(
    u => u.podName === pod.name && u.namespace === pod.namespace,
  )
  const podUsages: ImageUsage[] = ownUsages.length > 0
    ? ownUsages
    : [...new Map(workloadUsages.map(u => [`${u.containerName}/${u.image}`, u])).values()]


  const podIssues = data.issues.filter(i =>
    podUsages.some(u => u.image.includes(i.image)),
  )

  const totalContainers = podUsages.length
  const staleContainerCount = podUsages.filter(u =>
    STALE_STATUSES.includes(u.versionStatus.statusType),
  ).length
  const containerLabel = totalContainers === 1 ? "1 container" : `${totalContainers} containers`
  const nodeLabel = pod.nodeName ?? "—"

  const backHref = linkTo(`/topmost-owners/${workloadUid}`)

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <ResourceHeader
          icon={ICONS.pod}
          iconAriaLabel="Pod"
          title={pod.name}
          copyValue={pod.name}
          breadcrumbs={[
            { label: "Workloads", href: linkTo("/topmost-owners") },
            { label: `Namespace ${pod.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(pod.namespace)}`) },
            { label: `${workloadKind} ${workloadName}`, href: backHref },
            { label: `Pod ${pod.name}` },
          ]}
          chips={[
            { label: "Pod", tone: "brand" },
          ]}
          issueCount={podIssues.length + (pod.issues?.length ?? 0)}
          subtitle={`${pod.namespace} · ${nodeLabel} · ${containerLabel}`}
        />
        <PodNav workloadUid={workloadUid} podUid={podUid} namespace={pod.namespace} pod={pod.name} />

        <DetailLayout
          main={<>
            <CommandsCard namespace={pod.namespace} name={pod.name} ports={pod.declaredPorts} />
            <AlertsCard scope={{ namespace: pod.namespace, pods: [pod.name] }} hideWhenEmpty />
            <ScopeFindings scope={{ kind: "pod", namespace: pod.namespace, name: pod.name, workloadUid }} resourceIssues={pod.issues} />
            <PodShellAccess namespace={pod.namespace} name={pod.name} usages={ownUsages} />
            <ImagesCard usages={podUsages} livenessProbes={pod.livenessProbes ?? []} />
            <VolumesCard namespace={pod.namespace} pods={[pod.name]} />
            <PodTabs pod={pod} />
          </>}
          aside={<>
            {restartEnabled && <DeletePodAction namespace={pod.namespace} name={pod.name} uid={pod.uid} />}
            <PodStats
              pod={pod}
              nodeName={nodeLabel}
              totalContainers={totalContainers}
              staleContainerCount={staleContainerCount}
            />
            <PrometheusResourceUsageCard
              metrics={podMetrics}
              graphQueries={podMetricQueries(pod.namespace, pod.name)}
              emptyHint={pod.phase && pod.phase !== "Running" ? `pod is ${pod.phase}` : undefined}
              vertical
            />
          </>}
        />
      </Page>
    </div>
  )
}
