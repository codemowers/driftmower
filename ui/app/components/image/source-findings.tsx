"use client"

import MarkdownText from "@/app/components/markdown-text"

import { useEffect, useState, type ReactNode } from "react"
import { ExternalLink, LoaderCircle } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { sourceFindings } from "@/browser/catalog"
import type { ImageUsage } from "@/lib/cluster/reports"
import { sourceRepoUrl } from "@/lib/utils/oci-labels"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { advisoryUrl, CVE_SEVERITY_RANK, normalizeSeverity } from "@/lib/features/vulnerability"
import SeverityBadge from "./severity-badge"

type Finding = { advisory: string; summary?: string; severity?: string; confidence: string; fixedIn?: string; url?: string }
type Release = { tag: string; notes?: string; url?: string; published?: string }
type Source = { url: string; checkedAt?: string; errors?: string[]; releases?: Release[]; deployed: { version: string; findings?: Finding[] }[] }
type Result = { url: string; source?: Source; warnings?: string[]; error?: string }

const DEFAULT_VISIBLE = 3

function safeURL(raw?: string) {
  try { const url = new URL(raw ?? ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

// The crawler's findings for an image's source repository, fetched once per
// URL and shared by the advisories and releases cards.
const requests = new Map<string, Promise<Result>>()
function useSourceFindings(usage: ImageUsage) {
  const url = usage.imageInfo.crawlerSource?.url ?? sourceRepoUrl(usage.imageInfo.labels) ?? usage.imageInfo.sourceRepositories?.[0]?.url
  const version = usage.imageInfo.crawlerSource?.version
  const [result, setResult] = useState<Result>()
  useEffect(() => {
    if (!url) return
    let cancelled = false
    let request = requests.get(url)
    if (!request) {
      request = sourceFindings<{ sources: (Source & { advisories?: {id:string;summary?:string;url?:string}[] })[]; warnings?: string[] }>({url})
        .then(data => {
          const source = data.sources.find(s => s.url === url)
          if (source) for (const version of source.deployed) version.findings = version.findings?.map(f => ({...f, ...Object.fromEntries(Object.entries(source.advisories?.find(a => a.id === f.advisory) ?? {}).filter(([k]) => ["summary", "url"].includes(k)))}))
          return { url, source, warnings: data.warnings }
        })
        .catch((error: Error) => ({ url, error: String(error.message ?? error) }))
      requests.set(url, request)
      void request.finally(() => requests.delete(url))
    }
    void request.then(r => { if (!cancelled) setResult(r) })
    return () => { cancelled = true }
  }, [url])
  const current = result?.url === url ? result : undefined
  return { url, version, current, source: current?.source }
}

// A card in the vulnerabilities card's style: title on the left, when the
// data was gathered on the right.
function Card({ title, checkedAt, children }: { title: string; checkedAt?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-gray-200 bg-white px-6 py-5">
      <div className="-mx-6 mb-4 flex items-center justify-between border-b border-gray-200 px-6 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        {checkedAt && <p className="text-xs text-muted-foreground" title={new Date(checkedAt).toLocaleString()}>checked {compactRelativeTimeFromNow(checkedAt)}</p>}
      </div>
      {children}
    </section>
  )
}

function Status({ usage, url, current }: { usage: ImageUsage; url?: string; current?: Result }) {
  if (!url) return <p className="text-sm text-muted-foreground">{usage.imageInfo.sourceStatus === "unlinked" ? "No source repository associated." : "Source metadata unavailable."}</p>
  if (!current) return <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Loading source findings…</p>
  if (current.error) return <p role="alert" className="text-sm">Could not load source findings: {current.error}</p>
  if (!current.source) return <p className="text-sm text-muted-foreground">No crawler data available for this source.</p>
  return null
}

// Repository advisories and OSV matches for the deployed version, worst
// first, rendered like the image's CVEs.
export function SourceAdvisories({ usage }: { usage: ImageUsage }) {
  const [showAll, setShowAll] = useState(false)
  const { url, version, current, source } = useSourceFindings(usage)
  const deployed = version ? source?.deployed.find(d => d.version === version) : undefined
  const findings = [...(deployed?.findings ?? [])].sort((a, b) =>
    CVE_SEVERITY_RANK[normalizeSeverity(a.severity)] - CVE_SEVERITY_RANK[normalizeSeverity(b.severity)] || a.advisory.localeCompare(b.advisory))
  const visible = showAll ? findings : findings.slice(0, DEFAULT_VISIBLE)
  const incomplete = !source?.checkedAt || Boolean(source.errors?.length)

  return (
    <Card title={`Security advisories${version ? ` · ${version}` : ""}`} checkedAt={source?.checkedAt}>
      <Status usage={usage} url={url} current={current} />
      {source && <>
        {source.errors?.map(error => <p key={error} className="mb-2 text-sm text-amber-800">Incomplete crawl: {error}</p>)}
        {!deployed ? <p className="text-sm text-muted-foreground">This image has not been matched to a crawled source version.</p>
          : !findings.length ? <p className="text-sm text-muted-foreground">{incomplete ? "Advisory data is incomplete; no conclusion can be drawn." : "No matching repository advisories or OSV findings."}</p>
          : <>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Severity</th>
                    <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Advisory</th>
                    <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Fixed in</th>
                    <th className="pb-2 pr-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Match</th>
                    <th className="pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(finding => (
                    <tr key={finding.advisory} className="border-t border-gray-100">
                      <td className="py-2 pr-3 align-top whitespace-nowrap"><SeverityBadge severity={normalizeSeverity(finding.severity)} /></td>
                      <td className="py-2 pr-3 align-top whitespace-nowrap">
                        <a href={safeURL(finding.url) ?? advisoryUrl(finding.advisory)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-brand-text hover:underline">
                          {finding.advisory}<ExternalLink className="size-3 shrink-0" />
                        </a>
                      </td>
                      <td className="py-2 pr-3 align-top whitespace-nowrap">
                        {finding.fixedIn ? <span className="font-mono text-xs text-foreground">{finding.fixedIn}</span> : <span className="text-xs text-muted-foreground">no fix</span>}
                      </td>
                      <td className="py-2 pr-3 align-top text-xs whitespace-nowrap text-muted-foreground">{finding.confidence === "affected" ? "Affected" : "Possibly applicable"}</td>
                      <td className="w-full min-w-48 py-2 align-top">{finding.summary && <MarkdownText text={finding.summary} className="text-xs text-muted-foreground" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {findings.length > DEFAULT_VISIBLE && (
              <div className="mt-4 flex items-center border-t border-gray-100 pt-3">
                <button type="button" aria-expanded={showAll} onClick={() => setShowAll(s => !s)} className="text-xs text-muted-foreground hover:text-foreground">
                  {showAll ? `Show top ${DEFAULT_VISIBLE} advisories` : `Show all ${findings.length} advisories`}
                </button>
              </div>
            )}
          </>}
      </>}
      {current?.warnings?.map(warning => <p key={warning} className="mt-2 text-sm text-amber-800">{warning}</p>)}
    </Card>
  )
}

// Release notes are upstream Markdown: rendered without raw HTML, and links
// leave the dashboard.
function Notes({ text }: { text: string }) {
  return (
    <div className="prose-sm mt-3 max-w-none break-words text-sm [&_a]:text-brand-text [&_a]:underline [&_code]:font-mono [&_code]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-gray-50 [&_pre]:p-2 [&_ul]:list-disc">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={safeURL(href)} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </Markdown>
    </div>
  )
}

// Stable releases from the source repository, falling back to Git tags.
export function SourceReleases({ usage }: { usage: ImageUsage }) {
  const { url, version, current, source } = useSourceFindings(usage)
  return (
    <Card title="Releases" checkedAt={source?.checkedAt}>
      <Status usage={usage} url={url} current={current} />
      {source && (!source.releases?.length
        ? <p className="text-sm text-muted-foreground">{source.errors?.some(error => error.startsWith("releases:")) ? "Release notes could not be loaded because the release crawl failed." : "No stable releases or tags collected from the source repository."}</p>
        : <div className="flex flex-col gap-2">
          {source.releases.map(release => (
            <details key={release.tag} open={release.tag === version} className="rounded border border-gray-200 p-3 text-sm">
              <summary className="flex cursor-pointer items-center gap-2 font-medium">
                <span className="min-w-0 flex-1">
                  {release.tag}{release.tag === version ? " · deployed" : ""}
                  {release.published && <span className="font-normal text-muted-foreground"> · {new Date(release.published).toLocaleDateString()}</span>}
                </span>
                {safeURL(release.url) && (
                  <a href={safeURL(release.url)} target="_blank" rel="noreferrer" title="View upstream release" aria-label="View upstream release" onClick={e => e.stopPropagation()} className="shrink-0 text-muted-foreground hover:text-brand-text">
                    <ExternalLink className="size-4" />
                  </a>
                )}
              </summary>
              {release.notes ? <Notes text={release.notes} /> : <p className="mt-3 text-muted-foreground">No release-note text supplied by the source.</p>}
            </details>
          ))}
        </div>)}
    </Card>
  )
}
