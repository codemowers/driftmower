import PrefetchLink from "@/app/components/prefetch-link"
import { ShipWheel, Anchor, ArrowRight, ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import type { ReleaseInfo } from "@/lib/cluster/reports"

type Props =
  | { kind: "helm"; releaseInfo: ReleaseInfo; releaseUid: string; reportId: string | null }
  | { kind: "argo"; appName: string; url?: string; resourceKind?: string; resourceRef?: string }

const CARD_BASE =
  "flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4"
const CARD_INTERACTIVE =
  "group transition-colors hover:border-brand/40 hover:bg-brand-bg/30"

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

function HelmCard({ releaseInfo, releaseUid, reportId }: Extract<Props, { kind: "helm" }>) {
  const showAppVersion =
    releaseInfo.chartAppVersion && releaseInfo.chartAppVersion !== releaseInfo.chartVersion
  const chartName = releaseInfo.chartName ?? releaseInfo.name
  const href = reportId
    ? `/helm-releases/${releaseUid}?report=${reportId}`
    : `/helm-releases/${releaseUid}`

  return (
    <div>
      <SectionLabel>Managed by Helm</SectionLabel>
      <PrefetchLink href={href} className={`${CARD_BASE} ${CARD_INTERACTIVE}`}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <ShipWheel className="size-6" strokeWidth={2} />
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
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand-text" />
      </PrefetchLink>
    </div>
  )
}

const ARGO_LINK_HINT =
  "Links to Argo CD are off: the MCP server has no Argo CD address. Set the chart value mcp.argocd.url " +
  "to Argo CD's public URL; with Skaffold, put ARGO_URL=https://<argocd host> in skaffold.env.<cluster> and deploy again."

function ArgoCard({ appName, url, resourceKind, resourceRef }: Extract<Props, { kind: "argo" }>) {
  const subtext = resourceKind && resourceRef ? `${resourceKind} · ${resourceRef}` : "application"
  const inner = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
        <Anchor className="size-6" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-foreground">{appName}</p>
          <CopyButton value={appName} />
        </div>
        <p className="font-mono text-xs text-muted-foreground">{subtext}</p>
      </div>
      {url && <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand-text" />}
    </>
  )

  return (
    <div>
      <SectionLabel>Managed by Argo CD</SectionLabel>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className={`${CARD_BASE} ${CARD_INTERACTIVE}`}>
          {inner}
        </a>
      ) : (
        <div className={CARD_BASE} title={ARGO_LINK_HINT}>{inner}</div>
      )}
    </div>
  )
}

export default function ManagerCard(props: Props) {
  return props.kind === "helm" ? <HelmCard {...props} /> : <ArgoCard {...props} />
}
