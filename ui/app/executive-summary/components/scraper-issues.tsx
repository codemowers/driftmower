"use client"

import { useLayoutEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { Issue } from "@/lib/cluster/reports"
import ClusterWideTag from "@/app/components/cluster-wide-tag"

const TYPE_STYLE: Record<string, { bg: string; text: string }> = {
  scraper_failed:  { bg: "bg-status-major-bg", text: "text-status-major-label" },
  unauthorized:    { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  no_tags:         { bg: "bg-status-patch-bg",  text: "text-status-patch-label" },
}

function issueStyle(type: string) {
  return TYPE_STYLE[type] ?? { bg: "bg-gray-100", text: "text-muted-foreground" }
}

function splitImage(image: string): { registry: string | null; repo: string } {
  const ref = image.split("@")[0]
  const slash = ref.indexOf("/")
  if (slash === -1) return { registry: null, repo: ref }
  const registry = ref.slice(0, slash)
  const isRegistry = registry.includes(".") || registry.includes(":")
  return isRegistry ? { registry, repo: ref.slice(slash + 1) } : { registry: null, repo: ref }
}

const INITIAL_COUNT = 8

type Props = { issues: Issue[]; clusterWide?: boolean; onCollapsedHeight?: (height: number) => void }

export default function ScraperIssues({ issues, clusterWide, onCollapsedHeight }: Props) {
  const [expanded, setExpanded] = useState(false)
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const cardRef = useRef<HTMLDivElement>(null)
  const shown = expanded ? issues : issues.slice(0, INITIAL_COUNT)
  const overflow = issues.length - INITIAL_COUNT

  useLayoutEffect(() => {
    if (expanded) return
    const el = cardRef.current
    if (!el) return
    const update = () => onCollapsedHeight?.(el.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, issues, onCollapsedHeight])

  const targetByImage = useMemo(() => {
    const map = new Map<string, { uid: string; digest: string }>()
    for (const u of data?.report.imageUsages ?? []) {
      if (!u.workloadRootInfo) continue
      const repo = `${u.imageInfo.registry}/${u.imageInfo.repository}`
      const existing = map.get(repo)
      if (existing && existing.digest) continue
      map.set(repo, { uid: u.workloadRootInfo.uid, digest: u.imageInfo.digest })
    }
    return map
  }, [data])

  return (
    <div ref={cardRef} className="flex flex-col rounded-xl border border-gray-200 bg-white px-6 py-5">
      <div className="mb-4 flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Scraper Issues
        </p>
        {clusterWide && <ClusterWideTag />}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{data ? "No issues detected." : "–"}</p>
      ) : (
        <div className={cn("flex flex-col divide-y divide-gray-100", expanded && "max-h-160 overflow-y-auto")}>
          {shown.map((issue, i) => {
            const style = issueStyle(issue.type)
            const { registry, repo } = splitImage(issue.image)
            const target = targetByImage.get(issue.image)
            const content = (
              <>
                <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", style.bg, style.text)}>
                  {issue.type.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 truncate font-mono text-xs">
                  {registry && <span className="text-gray-400">{registry}/</span>}
                  <span className="text-muted-foreground">{repo}</span>
                </span>
              </>
            )
            if (!target) {
              return (
                <div key={i} className="-mx-2 flex items-center gap-3 px-2 py-2.5">
                  {content}
                </div>
              )
            }
            const reportQuery = reportId ? `?report=${reportId}` : ""
            const href = target.digest
              ? `/topmost-owners/${target.uid}/images/${encodeURIComponent(target.digest)}${reportQuery}`
              : `/topmost-owners/${target.uid}${reportQuery}`
            return (
              <Link
                key={i}
                href={href}
                className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-brand-bg/30"
              >
                {content}
              </Link>
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
