"use client"

import { useState, type ReactNode } from "react"
import { ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils/cn"
import { OCI_BASE_NAME, sortedLabelEntries, stripOciPrefix } from "@/lib/utils/oci-labels"
import type { ImageUsage } from "@/lib/cluster/reports"

const COLLAPSED_LABEL_COUNT = 8

const LABEL_PILL_CLASS =
  "max-w-full rounded bg-gray-100 px-1.5 py-px text-xs text-gray-600 [overflow-wrap:anywhere]"

function Row({ label, children, top }: { label: string; children: ReactNode; top?: boolean }) {
  return (
    <>
      <p className={cn("text-sm text-gray-600", top && "self-start")}>{label}</p>
      <div className={cn("min-w-0 font-mono text-sm text-foreground", top && "self-start")}>{children}</div>
    </>
  )
}

export default function TagIdentity({ usage }: { usage: ImageUsage }) {
  const { tag, digest, registry, repositoryUrl, labels } = usage.imageInfo
  const semver = usage.digestSemver?.tag ?? "—"
  const sameImageId = usage.imageId === digest
  const baseImage = labels?.[OCI_BASE_NAME]
  const labelEntries = sortedLabelEntries(labels)
  const [labelsExpanded, setLabelsExpanded] = useState(false)
  const visibleLabels = labelsExpanded ? labelEntries : labelEntries.slice(0, COLLAPSED_LABEL_COUNT)
  const hiddenLabelCount = labelEntries.length - COLLAPSED_LABEL_COUNT

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="-mx-6 mb-4 border-b border-gray-200 px-6 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Tag identity
      </p>

      <div className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-4">
        <Row label="Tag">{tag}</Row>

        <Row label="Semver">
          <span className={semver === "—" ? "text-muted-foreground" : undefined}>{semver}</span>
        </Row>

        <Row label="Image ID">
          {sameImageId
            ? <span className="text-muted-foreground">same as digest</span>
            : <span className="break-all">{usage.imageId}</span>}
        </Row>

        {usage.allActualTags.length > 1 && (
          <Row label="Also tagged">
            <span className="flex flex-wrap gap-1.5">
              {usage.allActualTags.map(t => (
                <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                  {t}
                </span>
              ))}
            </span>
          </Row>
        )}

        <Row label="Registry">
          {repositoryUrl ? (
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1.5 hover:text-brand-text hover:underline"
            >
              <span>{registry}</span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
            </a>
          ) : (
            registry
          )}
        </Row>
      </div>

      <div className="-mx-6 mt-5 grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-4 border-t border-gray-200 px-6 pt-4">
        <Row label="Base image">
          {baseImage ? (
            <span className="flex min-w-0 items-center gap-3">
              <span className="break-all text-xs text-gray-600">{baseImage}</span>
              <CopyButton value={baseImage} />
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        <Row label="Labels" top>
          {labelEntries.length > 0 ? (
            <TooltipProvider delayDuration={300}>
              <span className="flex flex-wrap items-center gap-1.5">
                {visibleLabels.map(([key, value]) => {
                  const displayKey = stripOciPrefix(key)
                  if (displayKey === key) {
                    return (
                      <span key={key} className={LABEL_PILL_CLASS}>
                        {key}={value}
                      </span>
                    )
                  }
                  return (
                    <Tooltip key={key}>
                      <TooltipTrigger asChild>
                        <span className={LABEL_PILL_CLASS}>
                          {displayKey}={value}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="font-mono">{key}</TooltipContent>
                    </Tooltip>
                  )
                })}
                {hiddenLabelCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setLabelsExpanded(v => !v)}
                    className={cn(
                      LABEL_PILL_CLASS,
                      "font-medium transition-colors hover:bg-gray-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                    )}
                  >
                    {labelsExpanded ? "show less" : `+${hiddenLabelCount} more`}
                  </button>
                )}
              </span>
            </TooltipProvider>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>
      </div>
    </div>
  )
}
