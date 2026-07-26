import { cn } from "@/lib/utils/cn"
import type { Issue } from "@/lib/cluster/reports"

const TYPE_STYLE: Record<string, { bg: string; text: string }> = {
  digest_verification_failed: { bg: "bg-status-major-bg", text: "text-status-major-label" },
  unauthorized:               { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  scraper_failed:             { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  no_tags:                    { bg: "bg-status-patch-bg", text: "text-status-patch-label" },
}

const FALLBACK_STYLE = { bg: "bg-gray-100", text: "text-muted-foreground" }

export default function ImageIssues({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null

  const sorted = [...issues].sort((a, b) => a.type.localeCompare(b.type))

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="-mx-6 mb-4 border-b border-gray-200 px-6 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Issues
      </p>

      <ul className="flex flex-col gap-2.5">
        {sorted.map((issue, idx) => {
          const badge = TYPE_STYLE[issue.type] ?? FALLBACK_STYLE
          return (
            <li key={idx} className="flex items-start gap-2 text-sm">
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", badge.bg, badge.text)}>
                {issue.type}
              </span>
              <span className="min-w-0 flex-1 text-foreground">{issue.message || issue.reason}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
