"use client"

import { useParams } from "next/navigation"
import { Package } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ImageUsage, StatusType } from "@/lib/cluster/reports"
import { SEVERITY_ORDER, STALE_STATUSES } from "@/lib/cluster/styles/status-style"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { podMetricQueries } from "@/lib/features/prometheus/pod-metrics"
import ResourceHeader from "@/app/components/resource-header"
import NetworkCard from "@/app/components/network-card"
import PrometheusResourceUsageCard from "@/app/components/prometheus-resource-usage-card"
import CommandsCard from "./components/commands-card"
import PodStats from "./components/pod-stats"
import PodLlmSummary from "./components/pod-llm-summary"
import IssuesCard from "./components/issues-card"
import PodTabs from "./components/pod-tabs"
import { usePodMetrics } from "./hooks/use-pod-metrics"

export default function PodDetailPage() {
  const { uid: workloadUid, podUid } = useParams<{ uid: string; podUid: string }>()
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()

  const pod = clusterResources?.find(r => r.uid === podUid && r.kind === "Pod") ?? null
  const podMetrics = usePodMetrics(pod?.namespace ?? "", pod?.name ?? "")

  const workloadMatch = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === workloadUid,
      )
    : undefined

  if (!data || !pod || !workloadMatch) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Pod not found</p>
        </main>
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

  const repoStatus = new Map<string, StatusType>()
  for (const u of podUsages) {
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

  const worstStatus = podUsages.reduce<StatusType>((worst, u) => {
    const s = u.versionStatus.statusType
    return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
  }, "no_data")

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
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Package}
          iconAriaLabel="Pod"
          title={pod.name}
          copyValue={pod.name}
          breadcrumbs={[
            { label: "Workloads", href: linkTo("/topmost-owners") },
            { label: `Namespace ${pod.namespace}` },
            { label: `${workloadKind} ${workloadName}`, href: backHref },
            { label: `Pod ${pod.name}` },
          ]}
          chips={[
            { label: "Pod", tone: "brand" },
          ]}
          scoreChip={{ status: worstStatus, score: normalizedScore }}
          issueCount={podIssues.length}
          subtitle={`${pod.namespace} · ${nodeLabel} · ${containerLabel}`}
        />

        <PodStats
          pod={pod}
          nodeName={nodeLabel}
          totalContainers={totalContainers}
          staleContainerCount={staleContainerCount}
          namespace={pod.namespace}
          worstStatus={worstStatus}
          normalizedScore={normalizedScore}
        />

        <PodLlmSummary pod={pod} />

        <PrometheusResourceUsageCard
          metrics={podMetrics}
          graphQueries={podMetricQueries(pod.namespace, pod.name)}
          emptyHint={pod.phase && pod.phase !== "Running" ? `pod is ${pod.phase}` : undefined}
        />

        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-5">
          <div className="md:col-span-3">
            <CommandsCard namespace={pod.namespace} name={pod.name} ports={pod.declaredPorts} />
          </div>
          <div className="md:col-span-2">
            <NetworkCard
              href={linkTo(`/topmost-owners/${workloadUid}/${podUid}/network-topology`)}
              podIPs={pod.ips ?? []}
            />
          </div>
        </div>

        <IssuesCard issues={podIssues} />

        <PodTabs pod={pod} usages={podUsages} issues={data.issues} workloadUid={workloadUid} />
      </main>
    </div>
  )
}
