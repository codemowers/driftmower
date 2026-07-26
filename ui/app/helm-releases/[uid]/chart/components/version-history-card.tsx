"use client"

import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils/cn"
import { compareChartVersions, normalizeChartVersion, sortChartVersionsDesc } from "@/app/helm-releases/utils/chart-versions"
import { canBuildChartCommands, isAbsoluteChartRef } from "./chart-commands-card"

const COLLAPSED_CELL_COUNT = 21

type Props = {
  stable: string[]
  prerelease: string[]
  deployed?: string
  latest?: string
  releaseName: string
  namespace: string
  chartSource?: string
  repoUrl?: string
}

function isPrereleaseVersion(version?: string): boolean {
  return Boolean(version?.includes("-"))
}

function ActionButton({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value)
        onCopy()
      }}
      className="w-full cursor-pointer rounded-md px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-brand-bg hover:text-brand-text"
    >
      {label}
    </button>
  )
}

export default function VersionHistoryCard({
  stable,
  prerelease,
  deployed,
  latest,
  releaseName,
  namespace,
  chartSource,
  repoUrl,
}: Props) {
  const deployedVersion = deployed ? normalizeChartVersion(deployed) : null
  const [showAll, setShowAll] = useState(false)
  const [includePrereleases, setIncludePrereleases] = useState(isPrereleaseVersion(deployedVersion ?? undefined))
  const [openVersion, setOpenVersion] = useState<string | null>(null)

  if (stable.length === 0 && prerelease.length === 0) return null

  const latestVersion = latest ? normalizeChartVersion(latest) : null
  const versions = includePrereleases ? sortChartVersionsDesc([...stable, ...prerelease]) : stable
  const prereleaseSet = new Set(prerelease)
  const visible = showAll ? versions : versions.slice(0, COLLAPSED_CELL_COUNT)

  const hasCommands = canBuildChartCommands(chartSource, repoUrl)
  const repoFlag = chartSource && repoUrl && !isAbsoluteChartRef(chartSource) ? ` --repo ${repoUrl}` : ""

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Version History
      </p>
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-3">
          <p className="text-xs text-muted-foreground">Published chart versions</p>
          <div className="flex shrink-0 items-center gap-4">
            {prerelease.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={includePrereleases} onCheckedChange={setIncludePrereleases} />
                Include prereleases
              </label>
            )}
            <p className="text-xs text-foreground">
              {stable.length} stable{" "}
              <span className="text-muted-foreground">
                +{prerelease.length} prerelease{prerelease.length === 1 ? "" : "s"}
              </span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-7">
          {visible.map(version => {
            const isDeployed = version === deployedVersion
            const isLatest = version === latestVersion
            const isPrerelease = prereleaseSet.has(version)
            const isUpgrade = deployedVersion ? compareChartVersions(version, deployedVersion) > 0 : true

            return (
              <Popover
                key={version}
                open={openVersion === version}
                onOpenChange={open => setOpenVersion(open ? version : null)}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex cursor-pointer items-center gap-2 border-b border-gray-100 px-4 py-2.5 text-left font-mono text-xs transition-colors hover:bg-gray-50",
                      isDeployed ? "bg-brand-bg font-semibold text-brand-text hover:bg-brand-bg" : "text-foreground",
                      isLatest && !isDeployed && "font-semibold",
                      isPrerelease && !isDeployed && "text-muted-foreground",
                    )}
                  >
                    {version}
                    {isDeployed && (
                      <span className="rounded-md bg-white px-1.5 py-0.5 text-[10px] font-semibold text-brand-label">
                        deployed
                      </span>
                    )}
                    {isLatest && !isDeployed && (
                      <span className="rounded-md bg-status-ok-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-ok-label">
                        latest
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 gap-0.5 p-1.5">
                  {hasCommands && chartSource && !isDeployed && (
                    <ActionButton
                      label={isUpgrade ? "Copy upgrade command" : "Copy downgrade command"}
                      value={`helm upgrade ${releaseName} ${chartSource}${repoFlag} --version ${version} -n ${namespace}`}
                      onCopy={() => setOpenVersion(null)}
                    />
                  )}
                  {hasCommands && chartSource && (
                    <ActionButton
                      label="Copy helm show chart command"
                      value={`helm show chart ${chartSource}${repoFlag} --version ${version}`}
                      onCopy={() => setOpenVersion(null)}
                    />
                  )}
                  <ActionButton label={`Copy version ${version}`} value={version} onCopy={() => setOpenVersion(null)} />
                </PopoverContent>
              </Popover>
            )
          })}
        </div>

        {versions.length > COLLAPSED_CELL_COUNT && (
          <button
            type="button"
            onClick={() => setShowAll(v => !v)}
            className="w-full px-5 py-2.5 text-left text-xs font-medium text-brand-label transition-colors hover:bg-gray-50 hover:text-brand-text"
          >
            {showAll ? "Show fewer versions" : `Show all ${versions.length} versions`}
          </button>
        )}
      </div>
    </div>
  )
}
