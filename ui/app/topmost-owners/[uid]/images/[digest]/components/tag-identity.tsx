"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import type { ImageUsage } from "@/lib/cluster/reports"

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <p className="text-sm text-gray-600">{label}</p>
      <div className="min-w-0 font-mono text-sm text-foreground">{children}</div>
    </>
  )
}

function ComingSoon() {
  return <span className="text-muted-foreground">Coming soon</span>
}

export default function TagIdentity({ usage }: { usage: ImageUsage }) {
  const { tag, digest, registry, repositoryUrl } = usage.imageInfo
  const semver = usage.digestSemver?.tag ?? "—"
  const sameImageId = usage.imageId === digest

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="-mx-6 mb-4 border-b border-gray-200 px-6 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Tag identity
      </p>

      <div className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-4">
        <Row label="Tag">{tag}</Row>

        <Row label="Semver">
          <span className={semver === "—" ? "text-muted-foreground" : undefined}>{semver}</span>
        </Row>

        <Row label="Digest">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="break-all">{digest}</span>
            <CopyButton value={digest} />
          </span>
        </Row>

        <Row label="Image ID">
          {sameImageId
            ? <span className="text-muted-foreground">same as digest</span>
            : <span className="break-all">{usage.imageId}</span>}
        </Row>

        {usage.allActualTags.length > 1 && (
          <Row label="Also tagged">
            <span className="flex flex-wrap gap-1.5">
              {usage.allActualTags.map(t => (
                <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                  {t}
                </span>
              ))}
            </span>
          </Row>
        )}

        <Row label="Registry">
          {repositoryUrl ? (
            <Link
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1.5 hover:text-brand-text hover:underline"
            >
              <span>{registry}</span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
            </Link>
          ) : (
            registry
          )}
        </Row>
      </div>

      <div className="-mx-6 mt-5 grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-4 border-t border-gray-200 px-6 pt-4">
        <Row label="Base image"><ComingSoon /></Row>
        <Row label="Labels"><ComingSoon /></Row>
      </div>
    </div>
  )
}
