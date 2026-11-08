"use client"

import { useMemo, useState } from "react";
import { useClusterState } from "@/lib/cluster/cluster-state";
import { useSandboxScope } from "@/lib/tenancy/sandbox-context";
import { currentChartScopes, deriveClusterActions } from "@/lib/features/actions/derive";
import TopActions from "./components/top-actions";
import { type StatValueTone } from "./components/stat-card";
import SectionLinkCard from "./components/section-link-card";
import DriftBreakdown from "./components/drift-breakdown";
import TechnicalDebtEstimate from "./components/technical-debt-estimate";
import DriftOverTime from "./components/drift-over-time";
import DriftRottennessSparkline from "./components/drift-rottenness-sparkline";
import MostOutdatedWorkloads, { worstStatus, type OutdatedWorkloadEntry } from "./components/most-outdated-workloads";
import ScraperIssues from "./components/scraper-issues";
import PageHeader from "../components/page-header";
import ClusterWideTag from "../components/cluster-wide-tag";
import SandboxEmptyState from "../components/sandbox-empty-state";
import { cn } from "@/lib/utils/cn";
import { Boxes, LayoutGrid, ShipWheel } from "lucide-react";
import type { ImageUsage } from "@/lib/cluster/reports";
import { reportWorkloadRoots } from "@/lib/utils/report-roots";
import { reportReadiness, type ReportReadiness } from "@/lib/cluster/report-readiness";
import { scopedHosts, useApplications } from "@/lib/features/applications/use-applications";

function rottennessValueTone(score: number): StatValueTone {
  if (score < 0.15) return "ok"
  if (score < 0.4) return "patch"
  if (score < 0.7) return "minor"
  return "major"
}

const valueToneText: Record<StatValueTone, string> = {
  ok: "text-status-ok-label",
  patch: "text-status-patch-label",
  minor: "text-status-minor-label",
  major: "text-status-major-label",
  ahead: "text-status-ahead-label",
  brand: "text-brand-label",
  muted: "text-muted-foreground",
}

function groupByWorkload(usages: ImageUsage[]): Map<string, ImageUsage[]> {
  return usages.reduce((map, u) => {
    if (!u.workloadRootInfo) return map
    const { kind, name, namespace } = u.workloadRootInfo
    const key = `${kind}/${namespace}/${name}`
    const group = map.get(key) ?? []
    group.push(u)
    map.set(key, group)
    return map
  }, new Map<string, ImageUsage[]>())
}

const DRIFT_SEVERITY: Record<string, number> = { major_behind: 3, minor_behind: 2, patch_behind: 1 }

// A score of 0.00 under "0 = healthy" reads as flawless, so it waits for something scorable.
const UNSCORABLE: Partial<Record<ReportReadiness, { value: string; caption: string }>> = {
  "no-reports": { value: "No analysis yet", caption: "Live inventory is loading" },
  unresolved: { value: "Cannot be scored", caption: "No container has a version to compare" },
}

export default function ExecutiveSummaryPage() {
  const { data, reportId, clusterResources, vulnerabilityReports, isFetchingReport } = useClusterState();
  const { launcher, inventory } = useApplications();
  const { sandboxes: scopedSandboxes, namespaces } = useSandboxScope();
  const [issuesHeight, setIssuesHeight] = useState<number | null>(null);
  const topActions = useMemo(
    () => (data ? deriveClusterActions(data, clusterResources, vulnerabilityReports, namespaces ? new Set(namespaces) : null) : []),
    [data, clusterResources, vulnerabilityReports, namespaces],
  )
  const ready = data !== null
  const rottennessScore = data?.rotenness.normalizedScore ?? 0;
  const rottennessTone = ready ? rottennessValueTone(rottennessScore) : "muted"

  const scopeSet = namespaces ? new Set(namespaces) : null
  const usages = (data?.report.imageUsages ?? [])
    .filter(u => !scopeSet || scopeSet.has(u.namespace))

  const currentCharts = currentChartScopes(usages)
  const workloadMap = groupByWorkload(usages)
  const ownerCount = reportWorkloadRoots(data).filter(r => !scopeSet || scopeSet.has(r.namespace)).length
  const helmReleaseCount = new Set(
    usages.flatMap(u => u.releaseInfo?.managementKind === "helm" ? [u.releaseInfo.groupKey] : [])
  ).size

  const okCount    = usages.filter(u => u.versionStatus.statusType === "up_to_date").length
  const patchCount = usages.filter(u => u.versionStatus.statusType === "patch_behind").length
  const minorCount = usages.filter(u => u.versionStatus.statusType === "minor_behind").length
  const majorCount = usages.filter(u => u.versionStatus.statusType === "major_behind").length
  const aheadCount = usages.filter(u => u.versionStatus.statusType === "ahead").length

  const readiness = reportReadiness({
    hasReport: ready,
    isFetchingReport,
    knownVersions: aheadCount + okCount + patchCount + minorCount + majorCount,
    containers: usages.length,
  })

  const unscorable = UNSCORABLE[readiness]

  const availableApps = launcher.status === "ready" ? launcher.entries.length : null
  const otherHosts =
    inventory.status === "ready" && inventory.tenancy === "ok"
      ? scopedHosts(inventory.entries, namespaces).length
      : 0

  const topOutdatedWorkloads: OutdatedWorkloadEntry[] = Array.from(workloadMap.entries())
    .map(([key, workloadUsages]) => {
      const status = worstStatus(workloadUsages)
      const worstUsage = workloadUsages.find(u => u.versionStatus.statusType === status)
      const { kind, name, namespace, uid } = workloadUsages[0].workloadRootInfo!
      return {
        key,
        uid,
        kind,
        name,
        namespace,
        currentTag: worstUsage?.versionStatus.deployedTag ?? "—",
        latestTag: worstUsage?.versionStatus.latestTag ?? null,
        statusType: status,
        score: DRIFT_SEVERITY[status] ?? 0,
      }
    })
    .filter(e => (DRIFT_SEVERITY[e.statusType] ?? 0) > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  // The selected sandbox's namespaces match nothing in the current report.
  const sandboxEmpty = scopedSandboxes.length > 0 && data !== null && usages.length === 0

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">

        {/* Header */}
        <PageHeader title="Executive Summary" subtitle="Monitor container drift across your cluster" />

        {sandboxEmpty ? (
          <SandboxEmptyState sandboxes={scopedSandboxes} entity="tracked containers" />
        ) : (
          <>
            <div className="grid grid-cols-[2fr_1px_3fr] gap-6 items-stretch">
              {/* Rottenness score: pre-computed in the report, cannot be re-scoped client-side */}
              <div
                className={cn(
                  "flex flex-col justify-center gap-1 rounded-3xl border border-gray-200 border-t-6 border-t-brand bg-white px-6",
                  unscorable ? "py-8" : "py-5",
                )}
              >
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Rottenness Score
                  </p>
                  {scopedSandboxes.length > 0 && <ClusterWideTag />}
                </div>
                {unscorable ? (
                  <>
                    <p className="text-xl font-medium text-muted-foreground">{unscorable.value}</p>
                    <p className="text-sm text-muted-foreground">{unscorable.caption}</p>
                  </>
                ) : (
                  <>
                    <p className={cn("text-4xl font-semibold tabular-nums", valueToneText[rottennessTone])}>
                      {ready ? rottennessScore.toFixed(2) : <span className="text-2xl font-normal">–</span>}
                    </p>
                    <DriftRottennessSparkline fallback={<p className="text-sm text-muted-foreground">0 = healthy · 1 = outdated</p>} />
                  </>
                )}
              </div>

              {/* Divider */}
              <div className="bg-gray-300" />

              <DriftBreakdown
                readiness={readiness}
                total={usages.length}
                ahead={aheadCount}
                ok={okCount}
                patch={patchCount}
                minor={minorCount}
                major={majorCount}
              />
            </div>

            {/* Section links */}
            <div className="flex w-full flex-wrap gap-5">
              <SectionLinkCard
                href={reportId ? `/applications?report=${reportId}` : "/applications"}
                title="Applications"
                count={availableApps}
                countEntity="applications"
                countText={`${availableApps} available to you`}
                hint={
                  otherHosts === 0
                    ? "Everything you can open on this cluster"
                    : namespaces
                      ? `Plus ${otherHosts} other hosts in your namespaces`
                      : `Plus ${otherHosts} hosts discovered`
                }
                icon={LayoutGrid}
              />
              <SectionLinkCard
                href={reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"}
                title="Topmost Owners"
                count={ready ? ownerCount : null}
                countEntity="owners"
                hint="Root controller of each workload"
                icon={Boxes}
              />
              <SectionLinkCard
                href={reportId ? `/helm-releases?report=${reportId}` : "/helm-releases"}
                title="Helm Releases"
                count={ready ? helmReleaseCount : null}
                countEntity="releases"
                hint="Installed charts and revision history"
                icon={ShipWheel}
              />
            </div>

            <DriftOverTime readiness={readiness} />

            <TechnicalDebtEstimate
              outdatedWorkloadCount={ready ? patchCount + minorCount + majorCount : null}
              readiness={readiness}
            />

            <TopActions rows={topActions} currentCharts={currentCharts} reportId={reportId} />

            <div className="grid grid-cols-[3fr_2fr] gap-5 items-start">
              <MostOutdatedWorkloads
                entries={topOutdatedWorkloads}
                reportId={reportId}
                matchHeight={issuesHeight}
                readiness={readiness}
              />
              <ScraperIssues issues={data?.issues ?? []} clusterWide={scopedSandboxes.length > 0} onCollapsedHeight={setIssuesHeight} />
            </div>
          </>
        )}

      </main>
    </div>
  );
}
