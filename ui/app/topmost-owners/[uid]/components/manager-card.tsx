import Link from "next/link"
import { Layers, ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import type { ReleaseInfo } from "@/lib/cluster/reports"

type Props = {
  releaseInfo: ReleaseInfo
  releaseUid: string
  reportId: string | null
}

export default function ManagerCard({ releaseInfo, releaseUid, reportId }: Props) {
  const showAppVersion =
    releaseInfo.chartAppVersion && releaseInfo.chartAppVersion !== releaseInfo.chartVersion
  const chartName = releaseInfo.chartName ?? releaseInfo.name
  const href = reportId
    ? `/helm-releases/${releaseUid}?report=${reportId}`
    : `/helm-releases/${releaseUid}`

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Managed by Helm
      </p>
      <div className="flex items-center gap-5 rounded-xl border border-gray-200 bg-white px-5 py-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <Layers className="size-6" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">{releaseInfo.name}</p>
            <CopyButton value={releaseInfo.name} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            chart: {chartName} · {releaseInfo.chartVersion}
            {showAppVersion && <> · app: {releaseInfo.chartAppVersion}</>}
          </p>
        </div>
        <Link
          href={href}
          className="flex shrink-0 items-center gap-1.5 text-sm text-brand-label transition-colors hover:text-brand-text hover:underline"
        >
          <ExternalLink className="size-3.5" />
          View release →
        </Link>
      </div>
    </div>
  )
}
