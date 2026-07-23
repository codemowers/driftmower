"use client"

import { Suspense } from "react"
import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import ReleaseList, { type ReleaseEntry } from "./components/release-list"
import TenantEmptyState from "../components/tenant-empty-state"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useTenantScope } from "@/lib/tenancy/tenant-context"
import { driftSummaryPills } from "@/lib/cluster/status-style"
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

export default function HelmReleasesPage() {
  const { data } = useClusterState()
  const { tenant, namespaces } = useTenantScope()
  const scopeSet = namespaces ? new Set(namespaces) : null

  const entries: ReleaseEntry[] = data
    ? Object.values(data.rotenness.releaseScores)
      .filter(score => !scopeSet || scopeSet.has(score.releaseInfo.namespace))
      .map(score => {
        const usages = data.report.releaseGroupMap[score.groupKey] ?? []

        const worstStatus = usages.reduce<StatusType>((worst, u) => {
          const s = u.versionStatus.statusType
          return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
        }, "no_data")

        const issueCount = data.issues.filter(i =>
          usages.some(u => u.image.includes(i.image))
        ).length

        return {
          groupKey: score.groupKey,
          releaseInfo: score.releaseInfo,
          normalizedScore: score.distinctRepoCount > 0 ? score.staleRepoCount / score.distinctRepoCount : 0,
          staleRepoCount: score.staleRepoCount,
          distinctRepoCount: score.distinctRepoCount,
          totalContainers: score.totalContainers,
          totalWorkloadCount: score.totalWorkloadCount,
          worstStatus,
          issueCount,
        }
      })
      .sort((a, b) => DISPLAY_ORDER[a.worstStatus] - DISPLAY_ORDER[b.worstStatus])
    : []

  const totalContainers = entries.reduce((s, e) => s + e.totalContainers, 0)
  const statusCounts = Object.fromEntries(
    (["up_to_date", "patch_behind", "minor_behind", "major_behind"] as StatusType[])
      .map(s => [s, entries.filter(e => e.worstStatus === s).length])
  ) as Partial<Record<StatusType, number>>
  const noDataCount = entries.filter(e => e.worstStatus === "no_data" || e.worstStatus === "no_version").length

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Helm Releases" subtitle="Installed charts and revision history" />
        <StatusSummaryBar
          totalLabel="releases"
          totalCount={entries.length}
          secondary={{ label: "containers", count: totalContainers }}
          pills={driftSummaryPills(statusCounts, noDataCount)}
        />
        {tenant && entries.length === 0 ? (
          <TenantEmptyState tenant={tenant} entity="Helm releases" />
        ) : (
          <Suspense>
            <ReleaseList entries={entries} />
          </Suspense>
        )}
      </main>
    </div>
  )
}
