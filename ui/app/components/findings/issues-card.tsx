"use client"

import { useState } from "react"
import Card from "@/app/components/layout/card"
import ShowMore from "./show-more"
import { compareIssues, issueBadge, issueCounts, ISSUE_STYLE, type WorkloadIssue } from "@/lib/cluster/issues"
import type { Issue } from "@/lib/cluster/reports"
import { cn } from "@/lib/utils/cn"

const BADGE = "rounded px-2 py-0.5 text-xs font-semibold"
const IMAGE_STYLE: Record<string, string> = {
  digest_verification_failed: "bg-status-major-bg text-status-major-label",
  unauthorized: "bg-status-minor-bg text-status-minor-label",
  scraper_failed: "bg-status-minor-bg text-status-minor-label",
  no_tags: "bg-status-patch-bg text-status-patch-label",
}

// The bare rows of resource issues, for use inside a list item.
export function ResourceIssueList({ issues }: { issues: WorkloadIssue[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map(issue => (
        <li key={`${issue.code}:${issue.message}`} className="flex items-start gap-2 text-sm">
          <span className={cn(BADGE, "shrink-0", ISSUE_STYLE[issue.severity].bg, ISSUE_STYLE[issue.severity].text)} title={issue.severity}>{issueBadge(issue)}</span>
          <span className="flex-1">{issue.message}</span>
          {issueCounts(issue) && <span className="shrink-0 text-xs text-muted-foreground">{issueCounts(issue)}</span>}
        </li>
      ))}
    </ul>
  )
}

type Row = { key: string; badge: string; style: string; message: string; detail?: string; meta?: string; mono?: string }

// Kubernetes resource issues and image metadata issues within one scope:
// the cluster, a namespace, a workload or a Pod.
export default function IssuesCard({ resourceIssues = [], imageIssues = [], limit, emptyText }: {
  resourceIssues?: WorkloadIssue[]
  imageIssues?: Issue[]
  limit?: number
  emptyText?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const rows: Row[] = [
    ...[...resourceIssues].sort(compareIssues).map(issue => ({
      key: `r:${issue.code}:${issue.message}`, badge: issueBadge(issue), style: cn(ISSUE_STYLE[issue.severity].bg, ISSUE_STYLE[issue.severity].text), message: issue.message,
      meta: issueCounts(issue) || undefined,
    })),
    ...[...imageIssues].sort((a, b) => a.type.localeCompare(b.type) || a.image.localeCompare(b.image)).map((issue, i) => ({
      key: `i:${i}:${issue.type}:${issue.image}`, badge: issue.type.replaceAll("_", " "), style: IMAGE_STYLE[issue.type] ?? "bg-gray-100 text-muted-foreground",
      message: issue.reason, detail: issue.message && issue.message !== issue.reason ? issue.message : undefined, mono: issue.image,
    })),
  ]
  if (rows.length === 0 && !emptyText) return null
  const visible = limit && !expanded ? rows.slice(0, limit) : rows
  return (
    <Card flush title="Issues" meta={rows.length || undefined}>
      {rows.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{emptyText}</p>}
      <ul className="divide-y divide-gray-100">
        {visible.map(row => (
          <li key={row.key} className="flex items-start gap-3 px-5 py-3 text-sm">
            <span className={cn(BADGE, "shrink-0", row.style)}>{row.badge}</span>
            <div className="min-w-0 flex-1">
              <p>{row.message}</p>
              {row.detail && <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p>}
              {row.mono && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={row.mono}>{row.mono}</p>}
            </div>
            {row.meta && <span className="shrink-0 text-xs text-muted-foreground">{row.meta}</span>}
          </li>
        ))}
      </ul>
      {limit && <ShowMore total={rows.length} limit={limit} expanded={expanded} onToggle={() => setExpanded(e => !e)} noun="issues" />}
    </Card>
  )
}
