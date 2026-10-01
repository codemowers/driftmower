"use client"

import { useRouter } from "next/navigation"
import { usePagePrefetch } from "@/app/components/prefetch-link"
import { Anchor, ExternalLink, ShipWheel, Users } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { chartDrift } from "@/lib/features/helm-releases/chart-versions"
import { isNoData } from "@/lib/cluster/styles/status-style"
import type { ApplicationEntry, ManagerLink } from "@/lib/features/applications/types"

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function initials(name: string) {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 2)
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()
}

const ICON_BUTTON =
  "relative z-10 cursor-default text-muted-foreground transition-colors hover:text-brand-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-background/70">{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  )
}

function ArgoIcon({ manager }: { manager: Extract<ManagerLink, { kind: "argo" }> }) {
  const label = `Argo application ${manager.name}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {manager.url ? (
          <a
            href={manager.url}
            target="_blank"
            rel="noreferrer"
            aria-label={label}
            onClick={e => e.stopPropagation()}
            className={ICON_BUTTON}
          >
            <Anchor className="size-4" />
          </a>
        ) : (
          <span aria-label={label} className="relative z-10 text-muted-foreground opacity-45">
            <Anchor className="size-4" />
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        <TooltipRow label="Argo application" value={manager.name} />
      </TooltipContent>
    </Tooltip>
  )
}

function HelmIcon({ manager }: { manager: Extract<ManagerLink, { kind: "helm" }> }) {
  const router = useRouter()
  const prefetchPage = usePagePrefetch()
  const { linkTo } = useContextHref()

  const deployed = manager.chartVersion
  const drift = chartDrift(deployed, manager.latestChartTag)
  const behind = !isNoData(drift) && drift !== "up_to_date" && drift !== "ahead"

  const releaseHref = manager.uid ? linkTo(`/helm-releases/${manager.uid}`, { drop: ["htab", "focus"] }) : null

  function prefetchRelease() {
    if (releaseHref) prefetchPage(releaseHref)
  }

  function openRelease(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (releaseHref) router.push(releaseHref)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={openRelease}
          onMouseEnter={prefetchRelease}
          onFocus={prefetchRelease}
          disabled={!manager.uid}
          aria-label={`Helm release ${manager.release}`}
          className={`${ICON_BUTTON} disabled:opacity-45 disabled:hover:text-muted-foreground`}
        >
          <ShipWheel className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-1.5">
          <TooltipRow label="Helm release" value={manager.release} />
          {manager.uid ? (
            <>
              {manager.chartName && (
                <TooltipRow
                  label="Chart"
                  value={`${manager.chartName}${deployed ? ` ${deployed}` : ""}`}
                />
              )}
              {behind && manager.latestChartTag && (
                <span className="font-mono text-status-minor">{manager.latestChartTag} available</span>
              )}
              {manager.chartAppVersion && manager.chartAppVersion !== deployed && (
                <TooltipRow label="App version" value={manager.chartAppVersion} />
              )}
            </>
          ) : (
            <span className="text-background/70">Not in this report</span>
          )}
          <TooltipRow label="Namespace" value={manager.namespace} />
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === "https:" || protocol === "http:" ? url : undefined
  } catch {
    return undefined
  }
}

export default function ApplicationTile({
  entry,
  manager,
}: {
  entry: ApplicationEntry
  manager: ManagerLink | null
}) {
  return (
    <div className="group relative flex items-center gap-4 rounded-lg border border-border bg-card px-5 py-6 transition-colors hover:border-brand/40 hover:bg-brand-bg/30 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-brand">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg font-mono text-base font-semibold tracking-tight text-brand-icon">
        {initials(entry.name)}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <a
          href={safeHref(entry.url)}
          target="_blank"
          rel="noreferrer"
          className="font-heading text-base font-semibold text-foreground after:absolute after:inset-0 focus-visible:outline-none"
        >
          {entry.name}
        </a>

        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate font-mono text-xs text-muted-foreground">{displayUrl(entry.url)}</p>
          <CopyButton value={entry.url} className="relative z-10 shrink-0" />
        </div>

        {entry.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{entry.description}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2.5 self-start">
        {entry.groups.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Access via ${entry.groups.join(", ")}`}
                className={ICON_BUTTON}
              >
                <Users className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex flex-col gap-0.5">
                <span className="text-background/70">Access via:</span>
                {entry.groups.map(group => (
                  <span key={group} className="font-mono">
                    {group}
                  </span>
                ))}
              </span>
            </TooltipContent>
          </Tooltip>
        )}

        {manager?.kind === "helm" && <HelmIcon manager={manager} />}
        {manager?.kind === "argo" && <ArgoIcon manager={manager} />}

        <ExternalLink
          className="size-4 text-muted-foreground transition-colors group-hover:text-brand-text"
          aria-hidden
        />
      </div>
    </div>
  )
}
