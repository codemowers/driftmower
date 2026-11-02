"use client"

import type { ReactNode } from "react"
import { ExternalLink, GitGraph } from "lucide-react"
import { OCI_DOCUMENTATION, OCI_REVISION, sourceRepoUrl } from "@/lib/utils/oci-labels"
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
}: {
  usage: ImageUsage
  showRevision?: boolean
}) {
  const { labels } = usage.imageInfo
  const repoUrl = sourceRepoUrl(labels)
  if (!repoUrl) return null

  const revision = showRevision ? labels?.[OCI_REVISION] : undefined
  const docs = labels?.[OCI_DOCUMENTATION]
  const docsUrl = docs?.startsWith("http") ? docs : undefined

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="-mx-6 mb-4 border-b border-gray-200 px-6 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Source
      </p>

      <a
        href={repoUrl}
        target="_blank"
        rel="noreferrer"
        className="group -mx-3 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-brand-bg/30"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <GitGraph className="size-6" strokeWidth={2} />
        </div>
        <p className="min-w-0 flex-1 font-mono text-sm font-medium text-foreground [overflow-wrap:anywhere] group-hover:text-brand-text">
          {repoDisplayPath(repoUrl)}
        </p>
        <ExternalLink className="size-4 shrink-0 text-muted-foreground group-hover:text-brand-text" />
      </a>

      {(revision || docsUrl) && (
        <div className="mt-3 border-t border-gray-200 pt-1">
          {revision && (
            <FooterLink label="Commit" href={`${repoUrl}/commit/${revision}`}>
              {revision.slice(0, SHORT_SHA_LENGTH)}
            </FooterLink>
          )}
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
