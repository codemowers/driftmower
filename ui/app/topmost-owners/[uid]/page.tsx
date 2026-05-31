"use client"

import { useParams } from "next/navigation"
import { Boxes } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import ResourceHeader from "@/app/components/resource-header"
import WorkloadStats from "./components/workload-stats"
import ManagerCard from "./components/manager-card"
import NetworkCard from "@/app/components/network-card"
import AiInsightsCard from "./components/ai-insights-card"
import WorkloadTabs from "./components/workload-tabs"

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

export default function WorkloadDetailPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const explorerResources = useClusterState(s => s.explorerResources)

  const match = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === uid,
      )
    : undefined

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
  const parts = groupKey.split("/")
  const [kind, namespace, name] = parts

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

  const backHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const containerLabel = totalContainers === 1 ? "1 container" : `${totalContainers} containers`
  const podLabel = totalPods === 1 ? "1 pod" : `${totalPods} pods`
  const headerChips: { label: string; tone?: "brand" | "muted" }[] = [{ label: kind, tone: "brand" }]
  if (!isHelm) headerChips.push({ label: "standalone", tone: "muted" })

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Boxes}
          iconAriaLabel="Workload"
          title={name}
          copyValue={name}
          breadcrumbs={[
            { label: "Topmost Owners", href: backHref },
            { label: name },
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

        {isHelm && ri && releaseUid && (
          <ManagerCard releaseInfo={ri} releaseUid={releaseUid} reportId={reportId} />
        )}

        <NetworkCard
          href={reportId ? `/topmost-owners/${uid}/network-topology?report=${reportId}` : `/topmost-owners/${uid}/network-topology`}
          scopeLabel={totalPods === 1 ? "1 pod" : `${totalPods} pods`}
        />

        <AiInsightsCard key={`${groupKey}:${reportId}`} workloadKey={groupKey} reportId={reportId} />

        <WorkloadTabs usages={usages} issues={data.issues} explorerResources={explorerResources} workloadUid={uid} reportId={reportId} />
      </main>
    </div>
  )
}
