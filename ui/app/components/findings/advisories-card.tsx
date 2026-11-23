"use client"

import MarkdownText from "@/app/components/markdown-text"

import { useEffect, useMemo, useState } from "react"
import { ExternalLink } from "lucide-react"
import { sourceFindings } from "@/browser/catalog"
import PrefetchLink from "@/app/components/prefetch-link"
import SeverityBadge from "@/app/components/image/severity-badge"
import LoadingLine from "@/app/components/loading-line"
import Card from "@/app/components/layout/card"
import ShowMore from "@/app/components/findings/show-more"
import type { ImageUsage } from "@/lib/cluster/reports"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { imagePath } from "@/lib/utils/image-artifacts"
import { advisoryUrl, CVE_SEVERITY_RANK, normalizeSeverity } from "@/lib/features/vulnerability"

type Finding = { advisory: string; severity?: string; confidence: string; fixedIn?: string; summary?: string; url?: string }
type Output = {
  workloads: { namespace: string; kind: string; name: string; images?: { image: string; source: string; version: string; findings?: Finding[] }[] }[]
}

type Row = {
  advisory: string
  severity: ReturnType<typeof normalizeSeverity>
  summary?: string
  url?: string
  affected: boolean
  images: Set<string>
  fixedIn: Set<string>
  workloads: Map<string, { namespace: string; kind: string; name: string }>
}

const DEFAULT_VISIBLE = 5

// Source advisories affecting the running images of one scope (the cluster,
// a namespace, a workload or a Pod), worst and widest first. Without a limit
// every advisory shows, as on the Advisories page.
export default function WorkloadAdvisories({ usages, limit = DEFAULT_VISIBLE, expanded = false }: { usages: ImageUsage[] | null; limit?: number; expanded?: boolean }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; output: Output }>({ status: "loading" })
  const [showAll, setShowAll] = useState(expanded)
  const { linkTo } = useContextHref()
  // usages comes from useScopeUsages, stable while the report is unchanged.
  useEffect(() => {
    if (!usages) return
    let cancelled = false
    sourceFindings<{ sources: { url: string; errors?: string[]; checkedAt?: string; advisories?: {id: string; summary?: string; url?: string}[]; deployed: { version: string; findings?: Finding[] }[] }[] }>({summary:"advisories"})
      .then(result => {
        const sources = new Map(result.sources.map(s => [s.url, s]))
        const groups = new Map<string, Output["workloads"][number]>()
        for (const usage of usages) {
          const root = usage.workloadRootInfo, linked = usage.imageInfo.crawlerSource
          if (usage.finished || !root || !linked) continue
          const source = sources.get(linked.url), deployed = source?.deployed.find(d => d.version === linked.version)
          if (!source || !deployed) continue
          let group = groups.get(root.groupKey)
          if (!group) { group = {namespace: root.namespace, kind: root.kind, name: root.name, images: []}; groups.set(root.groupKey, group) }
          const image = `${usage.imageInfo.registry}/${usage.imageInfo.repository}`
          if (group.images!.some(i => i.image === image && i.version === linked.version)) continue
          group.images!.push({image, source: linked.url, version: linked.version, findings: deployed.findings?.map(f => {
            const advisory = source.advisories?.find(a => a.id === f.advisory)
            return {...f, summary: advisory?.summary, url: advisory?.url}
          })})
        }
        return {workloads: [...groups.values()]} satisfies Output
      })
      .then(output => { if (!cancelled) setState({ status: "ready", output }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [usages])

  const rows = useMemo(() => {
    if (state.status !== "ready") return []
    const byAdvisory = new Map<string, Row>()
    for (const wl of state.output.workloads) {
      for (const image of wl.images ?? []) {
        for (const f of image.findings ?? []) {
          let row = byAdvisory.get(f.advisory)
          if (!row) {
            row = { advisory: f.advisory, severity: normalizeSeverity(f.severity), summary: f.summary, url: f.url, affected: false, fixedIn: new Set(), images: new Set(), workloads: new Map() }
            byAdvisory.set(f.advisory, row)
          }
          row.images.add(image.image)
          row.affected ||= f.confidence === "affected"
          if (f.fixedIn) row.fixedIn.add(f.fixedIn)
          row.workloads.set(`${wl.kind}/${wl.namespace}/${wl.name}`, wl)
        }
      }
    }
    return [...byAdvisory.values()].sort((a, b) =>
      CVE_SEVERITY_RANK[a.severity] - CVE_SEVERITY_RANK[b.severity] || Number(b.affected) - Number(a.affected) || b.workloads.size - a.workloads.size || a.advisory.localeCompare(b.advisory))
  }, [state])

  const visible = showAll ? rows : rows.slice(0, limit)

  return (
    <Card flush title="Security advisories" meta={rows.length > 0 ? `${rows.length} advisories` : undefined}>
      {state.status === "loading" && <div className="px-5 py-4"><LoadingLine loading="advisories" /></div>}
      {state.status === "error" && <p role="alert" className="px-5 py-4 text-sm text-status-major-label">Advisories could not be loaded: {state.message}</p>}
      {state.status === "ready" && rows.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No matching advisory findings in the currently available source data.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-5 py-3">Severity</th><th className="px-3 py-3">Advisory</th><th className="px-5 py-3">Affected images</th></tr></thead><tbody>
          {visible.map(row => (
              <tr key={row.advisory} className="border-b align-top last:border-0">
                <td className="px-5 py-3"><SeverityBadge severity={row.severity} /></td>
                <td className="min-w-0 px-3 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <a href={row.url ?? advisoryUrl(row.advisory)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-brand-text hover:underline">
                      {row.advisory}<ExternalLink className="size-3 shrink-0" />
                    </a>
                    {!row.affected && <span className="text-xs text-muted-foreground">possibly applicable</span>}
                    {row.fixedIn.size > 0 && <span className="text-xs text-muted-foreground">fixed in <span className="font-mono">{[...row.fixedIn].join(", ")}</span></span>}
                  </div>
                  {row.summary && <MarkdownText text={row.summary} className="line-clamp-3 text-sm text-foreground" />}
                </td>
                <td className="px-5 py-3"><div className="flex flex-col gap-1">{[...row.images].slice(0,3).map(image=><PrefetchLink key={image} href={linkTo(`/container-images/${imagePath(image)}`)} className="break-all font-mono text-xs text-brand-text hover:underline">{image}</PrefetchLink>)}{row.images.size>3&&<details className="text-xs"><summary className="cursor-pointer text-muted-foreground">+{row.images.size-3} more</summary>{[...row.images].slice(3).map(image=><PrefetchLink key={image} href={linkTo(`/container-images/${imagePath(image)}`)} className="mt-1 block break-all font-mono text-brand-text hover:underline">{image}</PrefetchLink>)}</details>}</div></td>
              </tr>
          ))}
        </tbody></table></div>
      )}
      {!expanded && <ShowMore total={rows.length} limit={limit} expanded={showAll} onToggle={() => setShowAll(s => !s)} noun="advisories" />}
    </Card>
  )
}
