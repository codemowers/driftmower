"use client"

import { useContextHref } from "@/lib/hooks/use-context-href"
import PrefetchLink from "@/app/components/prefetch-link"
import { sourceRepositoryPath } from "@/lib/features/crawler/sources"
import type { ReactNode } from "react"
import { ExternalLink, GitGraph } from "lucide-react"
import { OCI_DOCUMENTATION, OCI_REVISION, ownSourceRepoUrl, sourceRefUrl } from "@/lib/utils/oci-labels"
import type { ImageUsage } from "@/lib/cluster/reports"

const SHORT_SHA_LENGTH = 8

function repoDisplayPath(url: string): string {
  try {
    const { host, pathname } = new URL(url)
    return pathname.replace(/^\/|\/$/g, "") || host
  } catch {
    return url.replace(/^https?:\/\//, "")
  }
}

function FooterLink({ label, href, children }: { label: string; href: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2 text-sm">
      <span className="w-14 shrink-0 text-gray-600">{label}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="group min-w-0 font-mono text-foreground [overflow-wrap:anywhere] hover:text-brand-text hover:underline"
      >
        {children}
        <ExternalLink className="ml-1.5 inline size-3.5 align-[-2px] text-muted-foreground group-hover:text-brand-text" />
      </a>
    </div>
  )
}

export default function SourceCard({
  usage,
  showRevision = true,
  embedded = false,
}: {
  usage: ImageUsage
  showRevision?: boolean
  embedded?: boolean
}) {
  const { linkTo } = useContextHref()
  const { labels } = usage.imageInfo
  const safe = (raw?: string): raw is string => {
    if (!raw) return false
    try { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password } catch { return false }
  }
  const linked = usage.imageInfo.sourceRepositories ?? []
  const labelUrl = ownSourceRepoUrl(usage.imageInfo)
  const urls = [...new Set([...linked.map(source => source.url), ...(usage.imageInfo.crawlerSource?.url ? [usage.imageInfo.crawlerSource.url] : []), ...(labelUrl ? [labelUrl] : [])])].filter(safe)
  const repoUrl = urls[0]
  if (!repoUrl) {
    if (!usage.imageInfo.inheritedSource) return null
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Source</h2>
        <p>Unknown. The image&apos;s source metadata was inherited from its base image ({usage.imageInfo.inheritedSource}), so it does not identify where this image was built.</p>
        <p className="mt-2 text-xs text-muted-foreground">Set org.opencontainers.image.source and version on the image itself, or map the repository with an ImageRepository.</p>
      </section>
    )
  }

  const revision = showRevision ? (labels?.[OCI_REVISION] ?? labels?.["org.label-schema.vcs-ref"]) : undefined
  const tag = showRevision ? (labels?.["org.opencontainers.image.version"] ?? labels?.["org.label-schema.version"]) : undefined
  const refs = [{label: "Commit", value: revision, kind: "commit" as const}, {label: "Tag", value: tag, kind: "tag" as const}]
  const docs = labels?.[OCI_DOCUMENTATION]
  const docsUrl = safe(docs) ? docs : undefined

  return (
    <div className={embedded ? "min-w-0" : "rounded-xl border border-gray-200 bg-white px-5 py-4"}>
      <p className={embedded ? "mb-1 text-xs text-muted-foreground" : "-mx-5 mb-4 border-b border-gray-200 px-5 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground"}>
        Source
      </p>

      {urls.map(url => <PrefetchLink
        key={url}
        href={linkTo(sourceRepositoryPath(url))}
        className="group flex items-center gap-2 rounded-lg py-2 transition-colors hover:bg-brand-bg/30"
      >
        {!embedded && <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <GitGraph className="size-6" strokeWidth={2} />
        </div>}
        <p className="min-w-0 flex-1 font-mono text-sm font-medium text-foreground [overflow-wrap:anywhere] group-hover:text-brand-text">
          {repoDisplayPath(url)}
          {linked.find(source => source.url === url)?.name && <span className="mt-1 block text-xs font-normal text-muted-foreground">SourceRepository: {linked.find(source => source.url === url)?.name}</span>}
        </p>
      </PrefetchLink>)}
      {urls.map(url => <FooterLink key={url} label="Upstream" href={url}>{repoDisplayPath(url)}</FooterLink>)}

      {(revision || tag || docsUrl) && (
        <div className="mt-3 border-t border-gray-200 pt-1">
          {refs.map(({label, value, kind}) => {
            if (!value) return null
            const href = sourceRefUrl(labelUrl ?? repoUrl, value, kind)
            const text = kind === "commit" && /^[a-f0-9]{7,64}$/i.test(value) ? value.slice(0, SHORT_SHA_LENGTH) : value
            return href ? <FooterLink key={kind} label={label} href={href}>{text}</FooterLink> : <p key={kind} className="py-2 text-sm">{label}: <span className="font-mono">{text}</span></p>
          })}
          {docsUrl && (
            <FooterLink label="Docs" href={docsUrl}>
              {docsUrl.replace(/^https?:\/\//, "")}
            </FooterLink>
          )}
        </div>
      )}
    </div>
  )
}
