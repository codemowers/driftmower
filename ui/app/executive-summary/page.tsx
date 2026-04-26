"use client"

import { useClusterState } from "@/lib/cluster/cluster-state";
import StatCard, { type StatValueTone } from "./components/stat-card";
import SectionLinkCard from "./components/section-link-card";
import DriftBreakdown from "./components/drift-breakdown";
import TechnicalDebtEstimate from "./components/technical-debt-estimate";
import MostOutdatedWorkloads, { worstStatus, type OutdatedWorkloadEntry } from "./components/most-outdated-workloads";
import ScraperIssues from "./components/scraper-issues";
import PageHeader from "../components/page-header";
import { cn } from "@/lib/utils";
import { Boxes, ShipWheel } from "lucide-react";

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
  brand: "text-brand-label",
  muted: "text-muted-foreground",
}

export default function ExecutiveSummaryPage() {
  const { data } = useClusterState();
  const rottennessScore = data?.rotenness.normalizedScore ?? -1;
  const rottennessTone = rottennessValueTone(rottennessScore)

  const topmostOwnerCount = data ? Object.keys(data.report.workloadGroupMap).length : 0
  const helmReleaseCount = data
    ? Object.keys(data.report.releaseGroupMap).filter(k => k.startsWith("helm/")).length
    : 0

  const usages = data?.report.imageUsages ?? []
  const okCount    = usages.filter(u => u.versionStatus.statusType === "up_to_date").length
  const patchCount = usages.filter(u => u.versionStatus.statusType === "patch_behind").length
  const minorCount = usages.filter(u => u.versionStatus.statusType === "minor_behind").length
  const majorCount = usages.filter(u => u.versionStatus.statusType === "major_behind").length

  const DRIFT_SEVERITY: Record<string, number> = { major_behind: 3, minor_behind: 2, patch_behind: 1 }

  const topOutdatedWorkloads: OutdatedWorkloadEntry[] = data
    ? Object.entries(data.rotenness.workloadScores)
        .filter(([, score]) => score.normalizedScore > 0)
        .map(([key, score]) => {
          const workloadUsages = data.report.workloadGroupMap[key] ?? []
          const status = worstStatus(workloadUsages)
          const worstUsage = workloadUsages.find(u => u.versionStatus.statusType === status)
          return {
            key,
            kind:        score.workloadRootInfo.kind,
            name:        score.workloadRootInfo.name,
            namespace:   score.workloadRootInfo.namespace,
            currentTag:  worstUsage?.actualTag ?? "—",
            latestTag:   worstUsage?.versionStatus.latestTag ?? null,
            statusType:  status,
            score:       score.normalizedScore,
          }
        })
        .sort((a, b) =>
          (DRIFT_SEVERITY[b.statusType] ?? 0) - (DRIFT_SEVERITY[a.statusType] ?? 0)
          || b.score - a.score
        )
        .slice(0, 5)
    : []

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">

        {/* Header */}
        <PageHeader title="Executive Summary" subtitle="Monitor container drift across your cluster" />


        <div className="grid grid-cols-[2fr_1px_3fr] gap-6 items-stretch">
          {/* Rottenness score */}
          <div className="flex flex-col justify-center gap-1 rounded-3xl border border-gray-200 border-t-6 border-t-brand bg-white px-6 py-7">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Rottenness Score
            </p>
            <p className={cn("text-4xl font-semibold tabular-nums", valueToneText[rottennessTone])}>
              {rottennessScore.toFixed(2)}
            </p>
            <p className="text-sm text-muted-foreground">0 = healthy · 1 = outdated</p>
          </div>

          {/* Divider */}
          <div className="bg-gray-300" />

          {/* Status counts */}
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Container drift · <span className="tabular-nums">{usages.length}</span> containers tracked
            </p>
          <div className="grid grid-cols-4 gap-4">
            <StatCard value={okCount}    accent="ok"    valueTone="ok"    label="OK"    hint="up to date" />
            <StatCard value={patchCount} accent="patch" valueTone="patch" label="PATCH" hint="patch behind" />
            <StatCard value={minorCount} accent="minor" valueTone="minor" label="MINOR" hint="minor behind" />
            <StatCard value={majorCount} accent="major" valueTone="major" label="MAJOR" hint="major behind" />
          </div>
          </div>
        </div>


        {/* Section links */}
        <div className="flex w-full flex-wrap gap-5">
          <SectionLinkCard
            href="/topmost-owners"
            title="Topmost Owners"
            count={topmostOwnerCount}
            countEntity="owners"
            hint="Controllers at the root of each workload subtree"
            icon={Boxes}
          />
          <SectionLinkCard
            href="/helm-releases"
            title="Helm Releases"
            count={helmReleaseCount}
            countEntity="releases"
            hint="Installed charts and revision history"
            icon={ShipWheel}
          />
        </div>

        <DriftBreakdown ok={okCount} patch={patchCount} minor={minorCount} major={majorCount} />

        <div className="grid grid-cols-[3fr_2fr] gap-5">
          <MostOutdatedWorkloads entries={topOutdatedWorkloads} />
          <ScraperIssues issues={data?.issues ?? []} />
        </div>

        <TechnicalDebtEstimate outdatedWorkloadCount={patchCount + minorCount + majorCount}/>
      </main>
    </div>
  );
}
