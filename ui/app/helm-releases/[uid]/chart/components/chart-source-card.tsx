import { ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import { softWrapText } from "@/lib/utils/soft-wrap-text"
import type { ReleaseInfo } from "@/lib/cluster/reports"

const REPOSITORY_URLS: Record<string, (repository: string) => string> = {
  "quay.io": repository => `https://quay.io/repository/${repository}`,
  "docker.io": repository => `https://hub.docker.com/r/${repository}`,
  "ghcr.io": repository => {
    const [owner, ...rest] = repository.split("/")
    return `https://github.com/${owner}?tab=packages&q=${encodeURIComponent(rest[rest.length - 1] ?? "")}`
  },
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-5 py-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function MonoValue({ value }: { value?: string }) {
  return value ? (
    <span className="break-words font-mono text-xs text-foreground">{softWrapText(value)}</span>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">—</span>
  )
}

function KindChip({ kind }: { kind?: string }) {
  return kind ? (
    <span className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs font-semibold text-muted-foreground">
      {kind}
    </span>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">—</span>
  )
}

function HelmRepoRows({ releaseInfo }: { releaseInfo: ReleaseInfo }) {
  const { chartRepoUrl, chartSource, chartSourceKind } = releaseInfo
  return (
    <>
      <Row label="Repo URL">
        {chartRepoUrl ? (
          <a
            href={chartRepoUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1.5 break-words font-mono text-xs text-brand-label hover:text-brand-text hover:underline"
          >
            <span className="min-w-0">{softWrapText(chartRepoUrl)}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">—</span>
        )}
      </Row>
      <Row label="Chart">
        <MonoValue value={chartSource} />
      </Row>
      <Row label="Kind">
        <KindChip kind={chartSourceKind} />
      </Row>
    </>
  )
}

function OciRows({ releaseInfo }: { releaseInfo: ReleaseInfo }) {
  const { chartSource, chartRegistry, chartRepository, chartSourceKind } = releaseInfo
  const repositoryUrl =
    chartRegistry && chartRepository ? REPOSITORY_URLS[chartRegistry]?.(chartRepository) : undefined

  return (
    <>
      <Row label="Source">
        {chartSource ? (
          <span className="flex min-w-0 items-center gap-2">
            <code className="break-words font-mono text-xs text-foreground">{softWrapText(chartSource)}</code>
            <CopyButton value={chartSource} className="shrink-0" />
          </span>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">—</span>
        )}
      </Row>
      <Row label="Registry">
        <MonoValue value={chartRegistry} />
      </Row>
      <Row label="Repository">
        {chartRepository && repositoryUrl ? (
          <a
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1.5 break-words font-mono text-xs text-brand-label hover:text-brand-text hover:underline"
          >
            <span className="min-w-0">{softWrapText(chartRepository)}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <MonoValue value={chartRepository} />
        )}
      </Row>
      <Row label="Kind">
        <KindChip kind={chartSourceKind} />
      </Row>
    </>
  )
}

export default function ChartSourceCard({ releaseInfo }: { releaseInfo: ReleaseInfo }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <h2 className="border-b border-gray-200 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chart Source</h2>
      <div className="divide-y divide-gray-100">
        {releaseInfo.chartSourceKind === "helm-repo" ? (
          <HelmRepoRows releaseInfo={releaseInfo} />
        ) : (
          <OciRows releaseInfo={releaseInfo} />
        )}
      </div>
    </section>
  )
}
