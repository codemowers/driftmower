"use client"

import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow } from "@/lib/utils/format-time"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CVE_SEVERITY_STYLE, worstVulnerability, type VulnerabilityReport } from "@/lib/features/vulnerability"

export function TagCell({ tag, builtAt }: { tag: string | null; builtAt?: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-sm text-foreground">{tag ?? "—"}</span>
      {builtAt && (
        <Tooltip>
          <TooltipTrigger asChild>
            <time dateTime={builtAt} className="font-mono text-xs text-muted-foreground">
              {relativeTimeFromNow(builtAt)}
            </time>
          </TooltipTrigger>
          <TooltipContent>{builtAt}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

export function WorstCveCell({ report }: { report: VulnerabilityReport | null | undefined }) {
  if (report === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  if (report === null) {
    return (
      <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-semibold text-muted-foreground">
        No scan
      </span>
    )
  }
  const worst = worstVulnerability(report)
  if (!worst) {
    return (
      <span className="rounded-md bg-status-ok-bg px-2 py-1 text-xs font-semibold text-status-ok-label">
        Clean
      </span>
    )
  }
  const s = CVE_SEVERITY_STYLE[worst.severity]
  return (
    <span className={cn("rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap", s.bg, s.text)}>
      {s.label}{worst.score > 0 && ` ${worst.score}`}
    </span>
  )
}
