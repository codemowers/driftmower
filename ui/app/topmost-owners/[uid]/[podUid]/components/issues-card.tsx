import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { Issue } from "@/lib/cluster/reports"

type Props = {
  issues: Issue[]
}

const TYPE_STYLE: Record<string, { bg: string; text: string }> = {
  digest_verification_failed: { bg: "bg-status-major-bg", text: "text-status-major-label" },
  unauthorized:               { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  scraper_failed:             { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  no_tags:                    { bg: "bg-status-patch-bg", text: "text-status-patch-label" },
}

export default function IssuesCard({ issues }: Props) {
  if (issues.length === 0) return null

  const sorted = [...issues].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    return a.image.localeCompare(b.image)
  })

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Issues
      </p>
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="flex">
          <div className="w-1 shrink-0 bg-status-minor-bg" aria-hidden />
          <ul className="flex-1 divide-y divide-gray-100">
            {sorted.map((issue, idx) => {
              const style = TYPE_STYLE[issue.type] ?? { bg: "bg-gray-100", text: "text-muted-foreground" }
              const showMessage = issue.message && issue.message !== issue.reason
              return (
                <li key={idx} className="flex items-start gap-3 px-4 py-3">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-minor-label" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", style.bg, style.text)}>
                        {issue.type}
                      </span>
                      <span
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={issue.image}
                      >
                        {issue.image}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-foreground">{issue.reason}</p>
                    {showMessage && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{issue.message}</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
