"use client"

import { useParams } from "next/navigation"
import { Package } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { workloadKindLabel, type ImageUsage, type StatusType } from "@/lib/cluster/reports"
import ResourceHeader from "@/app/components/resource-header"
import NetworkCard from "@/app/components/network-card"
import PodStats from "./components/pod-stats"
import IssuesCard from "./components/issues-card"
import PodTabs from "./components/pod-tabs"

const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 4,
  minor_behind:  3,
  patch_behind:  2,
  up_to_date:    1,
  ahead:         0,
  no_data:      -1,
  no_version:   -1,
}

const STALE_STATUSES: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]

export default function PodDetailPage() {
  const { uid: workloadUid, podUid } = useParams<{ uid: string; podUid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const explorerResources = useClusterState(s => s.explorerResources)

  const pod = explorerResources?.find(r => r.uid === podUid && r.kind === "Pod") ?? null

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
  const workloadKind = workloadRoot?.kind ?? "—"
  const workloadApiGroup = explorerResources?.find(r => r.uid === workloadUid)?.apiGroup

  const podUsages: ImageUsage[] = data.report.imageUsages.filter(
    u => u.podName === pod.name && u.namespace === pod.namespace,
  )

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

  const backHref = reportId
    ? `/topmost-owners/${workloadUid}?report=${reportId}`
    : `/topmost-owners/${workloadUid}`

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Package}
          iconAriaLabel="Pod"
          title={pod.name}
          copyValue={pod.name}
          breadcrumbs={[
            { label: "Workloads", href: reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners" },
            { label: `Namespace ${pod.namespace}` },
            { label: `${workloadKindLabel(workloadKind, workloadApiGroup)} ${workloadName}`, href: backHref },
            { label: `Pod ${pod.name}` },
          ]}
          chips={[
            { label: "Pod", tone: "brand" },
            { label: pod.phase ?? "Unknown", tone: "muted" },
          ]}
          scoreChip={{ status: worstStatus, score: normalizedScore }}
          issueCount={podIssues.length}
          subtitle={`${pod.namespace} · ${nodeLabel} · ${containerLabel}`}
        />

        <PodStats
          phase={pod.phase ?? "Unknown"}
          nodeName={nodeLabel}
          totalContainers={totalContainers}
          staleContainerCount={staleContainerCount}
          namespace={pod.namespace}
          worstStatus={worstStatus}
          normalizedScore={normalizedScore}
        />

        <NetworkCard
          scopeLabel={containerLabel}
          href={reportId
            ? `/topmost-owners/${workloadUid}/${podUid}/network-topology?report=${reportId}`
            : `/topmost-owners/${workloadUid}/${podUid}/network-topology`
          }
        />

        <IssuesCard issues={podIssues} />

        <PodTabs pod={pod} usages={podUsages} issues={data.issues} workloadUid={workloadUid} reportId={reportId} />
      </main>
    </div>
  )
}
