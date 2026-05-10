"use client"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import WorkloadHeader from "./components/workload-header"
import WorkloadStats from "./components/workload-stats"
import ManagerCard from "./components/manager-card"
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

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <WorkloadHeader
          kind={kind}
          name={name}
          namespace={namespace}
          manager={{ kind: isHelm ? "helm" : "standalone" }}
          totalContainers={totalContainers}
          totalPods={totalPods}
          worstStatus={worstStatus}
          normalizedScore={normalizedScore}
          issueCount={issueCount}
          reportId={reportId}
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

        <WorkloadTabs usages={usages} issues={data.issues} explorerResources={explorerResources} workloadUid={uid} />
      </main>
    </div>
  )
}
