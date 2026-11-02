"use client"

import PrefetchLink from "@/app/components/prefetch-link"
import type { LinkTo } from "@/lib/hooks/use-context-href"
import type { ImageRelease } from "../../utils/image-entries"

export default function ManagedByCard({
  releases,
  linkTo,
}: {
  releases: ImageRelease[]
  linkTo: LinkTo
}) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white">
      <div className="flex items-baseline justify-between gap-4 border-b border-gray-200 px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Managed by</p>
        {releases.length > 0 && (
          <p className="shrink-0 text-xs text-muted-foreground">
            {releases.length} release{releases.length === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {releases.length > 0 ? (
        <div className="divide-y divide-gray-100">
          {releases.map(release => (
            <PrefetchLink
              key={release.uid}
              href={linkTo(`/helm-releases/${release.uid}`, { drop: ["htab", "focus"] })}
              className="flex flex-col gap-0.5 px-5 py-3 transition-colors hover:bg-brand-bg/40"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{release.name}</span>
                <span className="shrink-0 rounded-md bg-brand-bg px-2 py-0.5 text-xs font-semibold text-brand-label">
                  Helm
                </span>
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {release.chartName} {release.chartVersion}
                {release.revision !== undefined && ` · rev ${release.revision}`}
              </span>
            </PrefetchLink>
          ))}
        </div>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">Applied directly, not by a release.</p>
      )}
    </div>
  )
}
