"use client"

import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils/cn"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import type { ScrapeStatus } from "@/lib/cluster/reports"

const COLLAPSED_CELL_COUNT = 18

type Props = {
  considered: string[]
  offChannel: string[]
  availableCount: number
  deployedTags: string[]
  latest: string | null
  scrape?: ScrapeStatus
  failureReason: string | null
}

function scrapeSummary(scrape?: ScrapeStatus): string | null {
  if (!scrape) return null
  const state = scrape.success ? (scrape.partial ? "partial" : "ok") : "failed"
  return `scraped ${compactRelativeTimeFromNow(scrape.lastScrape)} · ${state}`
}

export default function TagHistoryCard({
  considered,
  offChannel,
  availableCount,
  deployedTags,
  latest,
  scrape,
  failureReason,
}: Props) {
  const [showAll, setShowAll] = useState(false)
  const [includeOffChannel, setIncludeOffChannel] = useState(false)

  const tags = includeOffChannel ? [...considered, ...offChannel] : considered
  const visible = showAll ? tags : tags.slice(0, COLLAPSED_CELL_COUNT)
  const offChannelSet = new Set(offChannel)
  const deployedSet = new Set(deployedTags)
  const summary = scrapeSummary(scrape)

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Tag history
      </p>
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-3">
          <p className="text-xs text-muted-foreground">
            Tags the scraper found for this repository · the candidates “latest” is resolved from
          </p>
          <div className="flex shrink-0 items-center gap-4">
            {offChannel.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={includeOffChannel} onCheckedChange={setIncludeOffChannel} />
                Include off-channel
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {considered.length} considered
              {offChannel.length > 0 && ` · +${offChannel.length} off-channel`}
              {availableCount > 0 && ` · ${availableCount} published`}
            </p>
          </div>
        </div>

        {tags.length > 0 ? (
          <>
            <div className="grid grid-cols-3 md:grid-cols-6">
              {visible.map(tag => {
                const isDeployed = deployedSet.has(tag)
                const isLatest = tag === latest
                return (
                  <div
                    key={tag}
                    className={cn(
                      "flex items-center gap-2 border-b border-gray-100 px-5 py-2.5 font-mono text-xs",
                      isDeployed ? "bg-brand-bg font-semibold text-brand-text" : "text-foreground",
                      isLatest && !isDeployed && "font-semibold",
                      offChannelSet.has(tag) && !isDeployed && "text-muted-foreground",
                    )}
                  >
                    <span className="truncate">{tag}</span>
                    {isDeployed && (
                      <span className="shrink-0 rounded-md bg-white px-1.5 py-0.5 text-[10px] font-semibold text-brand-label">
                        deployed
                      </span>
                    )}
                    {isLatest && !isDeployed && (
                      <span className="shrink-0 rounded-md bg-status-ok-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-ok-label">
                        latest
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {tags.length > COLLAPSED_CELL_COUNT && (
              <button
                type="button"
                onClick={() => setShowAll(v => !v)}
                className="w-full px-5 py-2.5 text-left text-xs font-medium text-brand-label transition-colors hover:bg-gray-50 hover:text-brand-text"
              >
                {showAll ? "Show fewer tags" : `Show all ${tags.length} tags`}
              </button>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-1.5 px-5 py-5">
            <p className="text-sm text-foreground">No tags resolved for this repository.</p>
            {failureReason && <p className="text-sm text-status-minor-label">{failureReason}</p>}
            <p className="text-xs text-muted-foreground">
              Without candidate tags no version comparison is possible, which is why drift reads “No data”.
            </p>
          </div>
        )}

        {summary && (
          <p className="border-t border-gray-100 px-5 py-2.5 text-xs text-muted-foreground">
            {summary}
            {scrape?.reason && ` · ${scrape.reason}`}
          </p>
        )}
      </div>
    </div>
  )
}
