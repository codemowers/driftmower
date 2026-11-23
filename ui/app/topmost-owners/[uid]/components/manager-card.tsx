import PrefetchLink from "@/app/components/prefetch-link"
import type React from "react"
import { ArrowRight, ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import type { ReleaseInfo } from "@/lib/cluster/reports"

type Props =
  | { kind: "helm"; releaseInfo: ReleaseInfo; releaseUid: string; reportId: string | null }
  | { kind: "argo"; appName: string; url?: string; resourceKind?: string; resourceRef?: string }

const CARD_BASE =
  "flex items-center gap-4 px-5 py-4"
const CARD_INTERACTIVE =
  "group transition-colors hover:bg-brand-bg/30"

// A card whose title sits in its own header row.
function Framed({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <h2 className="border-b border-gray-200 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
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
    <Framed title="Managed by Helm">
      <PrefetchLink href={href} className={`${CARD_BASE} ${CARD_INTERACTIVE}`}>
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
    </Framed>
  )
}

const ARGO_LINK_HINT =
  "Links to Argo CD are off: the MCP server has no Argo CD address. Set the chart value mcp.argocd.url " +
  "to Argo CD's public URL; with Skaffold, put ARGO_URL=https://<argocd host> in skaffold.env.<cluster> and deploy again."

function ArgoCard({ appName, url, resourceKind, resourceRef }: Extract<Props, { kind: "argo" }>) {
  const subtext = resourceKind && resourceRef ? `${resourceKind} · ${resourceRef}` : "application"
  const inner = (
    <>
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
    <Framed title="Managed by Argo CD">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className={`${CARD_BASE} ${CARD_INTERACTIVE}`}>
          {inner}
        </a>
      ) : (
        <div className={CARD_BASE} title={ARGO_LINK_HINT}>{inner}</div>
      )}
    </Framed>
  )
}

export default function ManagerCard(props: Props) {
  return props.kind === "helm" ? <HelmCard {...props} /> : <ArgoCard {...props} />
}
