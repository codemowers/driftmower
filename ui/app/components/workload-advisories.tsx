"use client"

import MarkdownText from "@/app/components/markdown-text"

import { useEffect, useMemo, useState } from "react"
import { ExternalLink } from "lucide-react"
import { sourceFindings } from "@/browser/catalog"
import PrefetchLink from "@/app/components/prefetch-link"
import SeverityBadge from "@/app/components/image/severity-badge"
import LoadingLine from "@/app/components/loading-line"
import { useClusterState } from "@/lib/cluster/cluster-state"
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

const DEFAULT_VISIBLE = 3

// Advisories that affect deployed workloads, worst and widest first: across
// the cluster, or in one namespace.
// The Advisories page shows every advisory from the start.
export default function WorkloadAdvisories({ namespace, expanded = false }: { namespace?: string; expanded?: boolean }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; output: Output }>({ status: "loading" })
  const [showAll, setShowAll] = useState(expanded)
  const data = useClusterState(s => s.data)
  const { linkTo } = useContextHref()

  useEffect(() => {
    if (!data) return
    let cancelled = false
    sourceFindings<{ sources: { url: string; errors?: string[]; checkedAt?: string; advisories?: {id: string; summary?: string; url?: string}[]; deployed: { version: string; findings?: Finding[] }[] }[] }>({summary:"advisories"})
      .then(result => {
        const sources = new Map(result.sources.map(s => [s.url, s]))
        const groups = new Map<string, Output["workloads"][number]>()
        for (const usage of data.report.imageUsages) {
          const root = usage.workloadRootInfo, linked = usage.imageInfo.crawlerSource
          if (usage.finished || !root || !linked || (namespace && root.namespace !== namespace)) continue
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
  }, [namespace, data])

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

  const visible = showAll ? rows : rows.slice(0, DEFAULT_VISIBLE)

  return (
    <section className="min-w-0 rounded-xl border border-gray-200 bg-white px-6 py-5">
      <div className="-mx-6 mb-4 flex items-center justify-between border-b border-gray-200 px-6 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Security advisories affecting workloads</p>
        {rows.length > 0 && <p className="text-xs tabular-nums text-muted-foreground">{rows.length} advisories</p>}
      </div>
      {state.status === "loading" && <LoadingLine loading="advisories" />}
      {state.status === "error" && <p className="text-sm text-muted-foreground">Advisories could not be loaded: {state.message}</p>}
      {state.status === "ready" && rows.length === 0 && <p className="text-sm text-muted-foreground">No matching advisory findings in the currently available source data.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto"><table className="w-full text-left"><thead className="border-b text-xs text-muted-foreground"><tr><th className="py-3 pr-3">Severity</th><th className="py-3 pr-5">Advisory</th><th className="py-3">Affected images</th></tr></thead><tbody>
          {visible.map(row => {
            return (
              <tr key={row.advisory} className="border-b align-top last:border-0">
                <td className="py-3 pr-3"><SeverityBadge severity={row.severity} /></td>
                <td className="min-w-0 py-3 pr-5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <a href={row.url ?? advisoryUrl(row.advisory)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-brand-text hover:underline">
                      {row.advisory}<ExternalLink className="size-3 shrink-0" />
                    </a>
                    {!row.affected && <span className="text-xs text-muted-foreground">possibly applicable</span>}
                    {row.fixedIn.size > 0 && <span className="text-xs text-muted-foreground">fixed in <span className="font-mono">{[...row.fixedIn].join(", ")}</span></span>}
                  </div>
                  {row.summary && <MarkdownText text={row.summary} className="line-clamp-3 text-sm text-foreground" />}
                </td>
                <td className="py-3"><div className="flex flex-col gap-1">{[...row.images].slice(0,3).map(image=><PrefetchLink key={image} href={linkTo(`/container-images/${imagePath(image)}`)} className="break-all font-mono text-xs text-brand-text hover:underline">{image}</PrefetchLink>)}{row.images.size>3&&<details className="text-xs"><summary className="cursor-pointer text-muted-foreground">+{row.images.size-3} more</summary>{[...row.images].slice(3).map(image=><PrefetchLink key={image} href={linkTo(`/container-images/${imagePath(image)}`)} className="mt-1 block break-all font-mono text-brand-text hover:underline">{image}</PrefetchLink>)}</details>}</div></td>
              </tr>
            )
          })}
        </tbody></table></div>
      )}
      {!expanded && rows.length > DEFAULT_VISIBLE && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <button type="button" aria-expanded={showAll} onClick={() => setShowAll(s => !s)} className="text-xs text-muted-foreground hover:text-foreground">
            {showAll ? `Show top ${DEFAULT_VISIBLE} advisories` : `Show all ${rows.length} advisories`}
          </button>
        </div>
      )}
    </section>
  )
}
