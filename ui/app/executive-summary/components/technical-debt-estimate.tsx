const AVG_UPGRADE_TIME = 1

function debtTone(hours: number): string {
  if (hours < 10)  return "text-status-ok-label"
  if (hours < 50)  return "text-status-patch-label"
  if (hours < 100) return "text-status-minor-label"
  return "text-status-major-label"
}

type Props = {
  outdatedWorkloadCount: number | null
}

export default function TechnicalDebtEstimate({ outdatedWorkloadCount }: Props) {
  const hours = outdatedWorkloadCount === null ? null : outdatedWorkloadCount * AVG_UPGRADE_TIME

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-6 py-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Technical Debt Estimate
        </p>
        {hours !== null && (
          <p className="text-sm text-gray-400">
            {outdatedWorkloadCount} outdated workloads × avg {AVG_UPGRADE_TIME}h upgrade time
          </p>
        )}
      </div>
      <p className={`text-4xl font-semibold tabular-nums ${hours === null ? "text-muted-foreground" : debtTone(hours)}`}>
        {hours === null ? <span className="text-2xl font-normal">–</span> : `~${hours}h`}
      </p>
    </div>
  )
}
