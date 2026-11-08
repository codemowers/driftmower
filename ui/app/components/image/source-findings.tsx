"use client"

import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { callTool } from "@/browser/connection"
import type { ImageUsage } from "@/lib/cluster/reports"
import { sourceRepoUrl } from "@/lib/utils/oci-labels"

type Finding = { advisory: string; summary?: string; severity?: string; confidence: string; fixedIn?: string; url?: string }
type Source = { url: string; checkedAt?: string; errors?: string[]; releases?: { tag: string; notes?: string; url?: string; published?: string }[]; deployed: { version: string; findings?: Finding[] }[] }
function safeURL(raw?: string) {
  try { const url = new URL(raw ?? ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

export default function SourceFindings({ usage }: { usage: ImageUsage }) {
  const url = usage.imageInfo.crawlerSource?.url ?? sourceRepoUrl(usage.imageInfo.labels) ?? usage.imageInfo.sourceRepositories?.[0]?.url
  const version = usage.imageInfo.crawlerSource?.version
  const [result, setResult] = useState<{ url: string; source?: Source; warnings?: string[]; error?: string }>()
  useEffect(() => {
    if (!url) return
    let cancelled = false
    callTool<{sources: Source[]; warnings?: string[]}>("get_source_findings", {url}).then(data => {
      if (!cancelled) setResult({url, source: data.sources.find(s => s.url === url), warnings: data.warnings})
    }).catch(error => { if (!cancelled) setResult({url, error: String(error.message ?? error)}) })
    return () => { cancelled = true }
  }, [url])
  const current = result?.url === url ? result : undefined
  const source = current?.source
  const deployed = version ? source?.deployed.find(d => d.version === version) : undefined
  const incomplete = !source?.checkedAt || Boolean(source.errors?.length)
  return <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-5">
    <h2 className="text-lg font-semibold">Upstream releases and security advisories</h2>
    {!url ? <p className="text-sm text-muted-foreground">{usage.imageInfo.sourceStatus === "unlinked" ? "No source repository associated." : "Source metadata unavailable."}</p> : !current ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Loading source findings…</p> : current.error ? <p role="alert">Could not load source findings: {current.error}</p> : !source ? <p>No crawler data available for this source.</p> : <>
      <p className="text-xs text-muted-foreground">{source.checkedAt ? `Last checked: ${new Date(source.checkedAt).toLocaleString()}` : "Not crawled yet."} Repository advisories and OSV matches; SBOM package scans are separate.</p>
      {source.errors?.map(error => <p key={error} className="text-sm text-amber-800">Incomplete crawl: {error}</p>)}
      <div className="space-y-3"><h3 className="font-semibold">Security advisories{version ? ` · ${version}` : ""}</h3>
        {!deployed ? <p className="text-sm text-muted-foreground">This image has not been matched to a crawled source version.</p> : !deployed.findings?.length ? <p className="text-sm text-muted-foreground">{incomplete ? "Advisory data is incomplete; no conclusion can be drawn." : "No matching repository advisories or OSV findings. This does not establish that the image is vulnerability-free."}</p> : deployed.findings.map(finding => <div key={finding.advisory} className="rounded border p-3 text-sm space-y-1">
          <p className="font-medium">{safeURL(finding.url) ? <a className="underline" href={safeURL(finding.url)} target="_blank" rel="noreferrer">{finding.advisory}</a> : finding.advisory} · {finding.severity ?? "Unknown severity"} · {finding.confidence === "affected" ? "Affected" : "Possibly applicable"}</p>
          <p>{finding.summary}</p><p>{finding.fixedIn ? `Fixed in ${finding.fixedIn}` : "Fixed version not identified"}</p>
        </div>)}
      </div>
      <div className="space-y-3"><h3 className="font-semibold">Release notes</h3><p className="text-xs text-muted-foreground">Stable releases collected from the source repository.</p>
        {!source.releases?.length ? <p className="text-sm text-muted-foreground">Release notes unavailable.</p> : source.releases.map(release => <details key={release.tag} className="rounded border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{release.tag}{release.tag === version ? " · deployed" : ""}{release.published ? ` · ${new Date(release.published).toLocaleDateString()}` : ""}</summary>
          {safeURL(release.url) && <a href={safeURL(release.url)} target="_blank" rel="noreferrer" className="mt-3 block underline">View upstream release</a>}
          <p className="mt-3 whitespace-pre-wrap break-words">{release.notes || "No release-note text supplied by the source."}</p>
        </details>)}
      </div>
    </>}
    {current?.warnings?.map(warning => <p key={warning} className="text-sm text-amber-800">{warning}</p>)}
  </section>
}
