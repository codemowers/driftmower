import type { ReportReadiness } from "@/lib/cluster/report-readiness"

const AVG_UPGRADE_TIME = 1

function debtTone(hours: number): string {
  if (hours < 10)  return "text-status-ok-label"
  if (hours < 50)  return "text-status-patch-label"
  if (hours < 100) return "text-status-minor-label"
  return "text-status-major-label"
}

type Props = {
  outdatedWorkloadCount: number | null
  readiness: ReportReadiness
}

const UNAVAILABLE: Partial<Record<ReportReadiness, { value: string; caption: string }>> = {
  "no-reports": { value: "Not yet estimated", caption: "Needs one analysis to size the work" },
  unresolved: { value: "Cannot be estimated", caption: "Needs at least one comparable version" },
}

export default function TechnicalDebtEstimate({ outdatedWorkloadCount, readiness }: Props) {
  const unavailable = UNAVAILABLE[readiness]
  const hours = outdatedWorkloadCount === null ? null : outdatedWorkloadCount * AVG_UPGRADE_TIME

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-6 py-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Technical Debt Estimate
        </p>
        {unavailable ? (
          <p className="text-sm text-gray-400">{unavailable.caption}</p>
        ) : (
          hours !== null && (
            <p className="text-sm text-gray-400">
              {outdatedWorkloadCount} outdated workloads × avg {AVG_UPGRADE_TIME}h upgrade time
            </p>
          )
        )}
      </div>
      {unavailable ? (
        <p className="text-xl font-medium text-muted-foreground">{unavailable.value}</p>
      ) : (
        <p className={`text-4xl font-semibold tabular-nums ${hours === null ? "text-muted-foreground" : debtTone(hours)}`}>
          {hours === null ? <span className="text-2xl font-normal">–</span> : `~${hours}h`}
        </p>
      )}
    </div>
  )
}
