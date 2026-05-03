import { Layers, ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import type { ReleaseInfo } from "@/lib/cluster/reports"

export default function ChartCard({ releaseInfo }: { releaseInfo: ReleaseInfo }) {
  const showAppVersion =
    releaseInfo.chartAppVersion && releaseInfo.chartAppVersion !== releaseInfo.chartVersion
  const chartName = releaseInfo.chartName ?? releaseInfo.name

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Helm Chart
      </p>
      <div className="flex items-center gap-5 rounded-xl border border-gray-200 bg-white px-5 py-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <Layers className="size-6" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">{chartName}</p>
            <CopyButton value={chartName} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            chart: {releaseInfo.chartVersion}
            {showAppVersion && <> · app: {releaseInfo.chartAppVersion}</>}
          </p>
        </div>
        <span className="flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-brand-label transition-colors hover:text-brand-text">
          <ExternalLink className="size-3.5" />
          View chart detail →
        </span>
      </div>
    </div>
  )
}
