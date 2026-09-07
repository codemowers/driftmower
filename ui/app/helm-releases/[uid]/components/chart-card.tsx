import Link from "next/link"
import { Map, ArrowRight } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import type { ReleaseInfo } from "@/lib/cluster/reports"
import { chartDrift } from "@/lib/features/helm-releases/chart-versions"
import { SEVERITY_STYLE, isNoData } from "@/lib/cluster/styles/status-style"

const CARD_BASE =
  "flex items-center gap-5 rounded-xl border border-gray-200 bg-white px-5 py-4"
const CARD_INTERACTIVE =
  "group transition-colors hover:border-brand/40 hover:bg-brand-bg/30"

function DriftIndicator({ releaseInfo }: { releaseInfo: ReleaseInfo }) {
  const deployed = releaseInfo.chartSourceVersion ?? releaseInfo.chartVersion
  const status = chartDrift(deployed, releaseInfo.latestChartTag)
  if (isNoData(status)) return null

  const style = SEVERITY_STYLE[status]
  if (!style) return null

  const label = status === "up_to_date" ? "Up to date" : style.label
  return (
    <>
      {status !== "up_to_date" && status !== "ahead" && (
        <span className="font-mono text-xs text-muted-foreground">
          {releaseInfo.latestChartTag} available
        </span>
      )}
      <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${style.bg} ${style.text}`}>
        {label}
      </span>
    </>
  )
}

export default function ChartCard({ releaseInfo, href }: { releaseInfo: ReleaseInfo; href: string }) {
  const showAppVersion =
    releaseInfo.chartAppVersion && releaseInfo.chartAppVersion !== releaseInfo.chartVersion
  const chartName = releaseInfo.chartName ?? releaseInfo.name

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Helm Chart
      </p>
      <Link href={href} className={`${CARD_BASE} ${CARD_INTERACTIVE}`}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <Map className="size-6" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">{chartName}</p>
            <CopyButton value={chartName} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            chart version: {releaseInfo.chartVersion}
            {showAppVersion && <> · app: {releaseInfo.chartAppVersion}</>}
            {releaseInfo.chartRegistry && <> · {releaseInfo.chartRegistry}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <DriftIndicator releaseInfo={releaseInfo} />
          <ArrowRight className="size-4 text-muted-foreground transition-colors group-hover:text-brand-text" />
        </div>
      </Link>
    </div>
  )
}
