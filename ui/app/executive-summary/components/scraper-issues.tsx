"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"

type Issue = { image: string; type: string; message: string }

const TYPE_STYLE: Record<string, { bg: string; text: string }> = {
  scraper_failed:  { bg: "bg-status-major-bg", text: "text-status-major-label" },
  unauthorized:    { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  no_tags:         { bg: "bg-gray-100",         text: "text-muted-foreground" },
}

function issueStyle(type: string) {
  return TYPE_STYLE[type] ?? { bg: "bg-gray-100", text: "text-muted-foreground" }
}

function shortImage(image: string): string {
  return image.replace(/^[^/]+\//, "").split("@")[0]
}

const INITIAL_COUNT = 8

type Props = { issues: Issue[] }

export default function ScraperIssues({ issues }: Props) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? issues : issues.slice(0, INITIAL_COUNT)
  const overflow = issues.length - INITIAL_COUNT

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Scraper Issues
      </p>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No issues detected.</p>
      ) : (
        <div className={cn("flex flex-col divide-y divide-gray-100", expanded && "max-h-160 overflow-y-auto")}>
          {shown.map((issue, i) => {
            const style = issueStyle(issue.type)
            return (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", style.bg, style.text)}>
                  {issue.type.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {shortImage(issue.image)}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {overflow > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-3 w-fit text-xs text-muted-foreground hover:text-brand hover:underline"
        >
          +{overflow} more
        </button>
      )}
      {expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-3 w-fit text-xs text-muted-foreground hover:text-brand hover:underline"
        >
          show less
        </button>
      )}
    </div>
  )
}
