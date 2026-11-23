"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { Suspense } from "react"
import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import ReleaseList, { type ReleaseEntry } from "./components/release-list"
import SandboxEmptyState from "../components/sandbox-empty-state"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { DISPLAY_ORDER, DRIFT_PILL_STATUSES, SEVERITY_ORDER, driftSummaryPills, isNoData } from "@/lib/cluster/styles/status-style"
import type { StatusType } from "@/lib/cluster/reports"

export default function HelmReleasesPage() {
  const { data } = useClusterState()
  const { sandboxes: scopedSandboxes, namespaces } = useSandboxScope()
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
    DRIFT_PILL_STATUSES.map(s => [s, entries.filter(e => e.worstStatus === s).length])
  ) as Partial<Record<StatusType, number>>
  const noDataCount = entries.filter(e => isNoData(e.worstStatus)).length

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.helmReleases} title="Helm Releases" subtitle="HelmChart declarations and discovered releases" />
        <StatusSummaryBar
          totalLabel="releases"
          totalCount={entries.length}
          secondary={{ label: "containers", count: totalContainers }}
          pills={driftSummaryPills(statusCounts, noDataCount)}
        />
        {scopedSandboxes.length > 0 && entries.length === 0 ? (
          <SandboxEmptyState sandboxes={scopedSandboxes} entity="Helm releases" />
        ) : (
          <Suspense>
            <ReleaseList entries={entries} />
          </Suspense>
        )}
      </Page>
    </>
  )
}
