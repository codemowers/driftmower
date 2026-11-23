"use client"

import Card from "@/app/components/layout/card"
import { useRegistryQuery } from "@/lib/features/base-images/use-registry-query"
import type { RepositorySummary, RegistryStatus } from "@/lib/features/base-images/types"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"

function RegistryState({ status }: { status: RegistryStatus }) {
  const color = status.state === "throttled" ? "bg-status-minor-bg text-status-minor-label" : status.state === "scraping" ? "bg-brand-bg text-brand-label" : "bg-gray-100 text-muted-foreground"
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${color}`}>{status.state}</span>
}

// The registry scraper's state: per-registry activity and the configured
// base-image repositories it indexes for image ancestry.
export default function BaseImageCatalog() {
  const result = useRegistryQuery<{ repositories: RepositorySummary[]; registries?: RegistryStatus[]; observedAt?: string }>("list_base_image_repositories", {})
  const registries = result?.data?.registries ?? []
  const repositories = result?.data?.repositories ?? []
  return <Card flush title="Base image catalog" meta={result?.data?.observedAt ? `observed ${compactRelativeTimeFromNow(result.data.observedAt)}` : undefined}>
    {result?.error ? <p className="p-5 text-sm text-muted-foreground">Catalog unavailable: {result.error}</p>
      : !result ? <p className="p-5 text-sm text-muted-foreground">Loading base image catalog…</p> : <>
        {registries.length > 0 && <ul className="divide-y border-b border-gray-200">{registries.map(status => <li key={status.registry} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-xs text-muted-foreground">
          <span className="font-mono text-sm text-foreground">{status.registry}</span><RegistryState status={status} />
          <span>{status.authentication === "authenticated" ? "authenticated" : "anonymous"}</span>
          <span>{status.activeRepositories.length} active</span>
          <span>last success {status.lastSuccess ? compactRelativeTimeFromNow(status.lastSuccess) : "none this run"}</span>
          {status.lastHTTPStatus ? <span>HTTP {status.lastHTTPStatus}</span> : null}
          {status.lastError && <span className="w-full break-words text-status-major-label">{status.lastError}</span>}
        </li>)}</ul>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted text-xs text-muted-foreground"><tr><th className="px-5 py-3">Repository</th><th className="px-3 py-3">Version tags</th><th className="px-3 py-3">Platform images</th><th className="px-5 py-3">Last scrape</th></tr></thead><tbody>
          {repositories.map(repo => <tr key={repo.repository} className="border-t align-top"><td className="px-5 py-3 font-mono">{repo.repository}{repo.errors?.length ? <p className="mt-1 font-sans text-xs text-status-major-label">{repo.errors[0]}</p> : null}</td><td className="px-3 py-3 tabular-nums">{repo.matchedTags}</td><td className="px-3 py-3 tabular-nums">{repo.imageCount}</td><td className="px-5 py-3 text-xs text-muted-foreground">{repo.checkedAt ? compactRelativeTimeFromNow(repo.checkedAt) : "not scraped yet"}</td></tr>)}
        </tbody></table></div>
      </>}
  </Card>
}
