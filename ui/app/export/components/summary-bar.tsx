import { formatSize, MANIFEST_COUNT, type Artifact } from "../data"

type Props = {
  artifacts: Artifact[]
  chartCount: number
}

export default function SummaryBar({ artifacts, chartCount }: Props) {
  const total = artifacts.length
  const signed = artifacts.filter(a => a.signed).length
  const withSbom = artifacts.filter(a => a.sbom).length
  const size = artifacts.reduce((n, a) => n + a.sizeBytes, 0)

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-3.5">
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold tabular-nums text-foreground">{total}</span> images</span>
        <span className="text-gray-200">|</span>
        <span><span className="font-semibold tabular-nums text-foreground">{chartCount}</span> Helm charts</span>
        <span className="text-gray-200">|</span>
        <span><span className="font-semibold tabular-nums text-foreground">{MANIFEST_COUNT}</span> manifests</span>
        <span className="text-gray-200">|</span>
        <span className="font-semibold tabular-nums text-foreground">{formatSize(size)}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="rounded-md bg-status-ok-bg px-3 py-1.5 text-xs font-semibold tabular-nums text-status-ok-label">
          {signed}/{total} signed
        </span>
        <span className="rounded-md bg-status-ok-bg px-3 py-1.5 text-xs font-semibold tabular-nums text-status-ok-label">
          {withSbom}/{total} SBOM
        </span>
      </div>
    </div>
  )
}
