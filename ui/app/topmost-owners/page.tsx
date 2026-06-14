"use client"

import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import WorkloadList, { type WorkloadEntry } from "./components/workload-list"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import type { StatusType } from "@/lib/cluster/reports"

const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 4,
  minor_behind:  3,
  patch_behind:  2,
  up_to_date:    1,
  ahead:         0,
  no_data:      -1,
  no_version:   -1,
}

const DISPLAY_ORDER: Record<StatusType, number> = {
  major_behind: 0,
  minor_behind: 1,
  patch_behind: 2,
  up_to_date:   3,
  ahead:        4,
  no_data:      5,
  no_version:   5,
}

const STALE_STATUSES: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]

export default function TopmostOwnersPage() {
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)

  const releaseUidByGroupKey = new Map<string, string>()
  if (data) {
    for (const score of Object.values(data.rotenness.releaseScores)) {
      releaseUidByGroupKey.set(score.releaseInfo.groupKey, score.releaseInfo.uid)
    }
  }

  const workloads: WorkloadEntry[] = data
    ? Object.entries(data.report.workloadGroupMap)
        .filter(([key]) => key !== "unknown")
        .map(([key, usages]): WorkloadEntry | null => {
          const parts = key.split("/")
          if (parts.length < 3) return null
          const [kind, namespace, name] = parts

          const uid = usages[0]?.workloadRootInfo?.uid
          if (!uid) return null

          const ri = usages[0]?.releaseInfo
          const releaseUid = ri ? releaseUidByGroupKey.get(ri.groupKey) : undefined
          const argoApp = usages[0]?.workloadRootInfo
            ? findWorkloadRoot(clusterResources, usages[0].workloadRootInfo)?.argoApp
            : undefined
          const manager: WorkloadEntry["manager"] =
            ri?.managementKind === "helm" && releaseUid
              ? { kind: "helm", name: ri.name, uid: releaseUid }
              : argoApp
                ? { kind: "argo", name: argoApp.name, url: argoApp.url }
                : { kind: "standalone" }

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

          const worstStatus = usages.reduce<StatusType>((worst, u) => {
            const s = u.versionStatus.statusType
            return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
          }, "no_data")

          const issueCount = data.issues.filter(i =>
            usages.some(u => u.image.includes(i.image))
          ).length

          return {
            groupKey: key,
            uid,
            kind,
            name,
            namespace,
            manager,
            containerCount: usages.length,
            staleRepoCount,
            distinctRepoCount,
            worstStatus,
            issueCount,
          }
        })
        .filter((w): w is WorkloadEntry => w !== null)
        .sort((a, b) => DISPLAY_ORDER[a.worstStatus] - DISPLAY_ORDER[b.worstStatus])
    : []

  const totalContainers = workloads.reduce((s, w) => s + w.containerCount, 0)

  const statusCounts = Object.fromEntries(
    (["up_to_date", "patch_behind", "minor_behind", "major_behind"] as StatusType[])
      .map(s => [s, workloads.filter(w => w.worstStatus === s).length])
  ) as Partial<Record<StatusType, number>>

  const noDataCount = workloads.filter(w => w.worstStatus === "no_data" || w.worstStatus === "no_version").length

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Topmost Owners" subtitle="Controllers at the root of each workload subtree" />
        <StatusSummaryBar
          totalLabel="workloads"
          totalCount={workloads.length}
          secondaryLabel="containers"
          secondaryCount={totalContainers}
          statusCounts={statusCounts}
          noDataCount={noDataCount}
        />
        <WorkloadList entries={workloads} />
      </main>
    </div>
  )
}
