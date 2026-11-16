"use client"

import { useState } from "react"
import Link from "next/link"
import { Layers } from "lucide-react"
import ResourceHeader from "@/app/components/resource-header"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useRegistryQuery } from "@/lib/features/base-images/use-registry-query"
import { repositoryPath, type RepositorySummary, type RegistryStatus } from "@/lib/features/base-images/types"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"

export default function BaseImagesPage() {
  const { linkTo } = useContextHref()
  const [filter, setFilter] = useState("")
  const result = useRegistryQuery<{ repositories: RepositorySummary[]; registries?: RegistryStatus[]; observedAt?: string }>("list_base_image_repositories", {})
  const registries = result?.data?.registries ?? []
  const repositories = result?.data?.repositories.filter(repo => repo.repository.toLowerCase().includes(filter.toLowerCase())) ?? []
  return <main className="flex w-full flex-col gap-6 px-7 py-12">
    <ResourceHeader icon={Layers} iconAriaLabel="Base images" title="Base Images" breadcrumbs={[{ label: "Base Images" }]} subtitle="Public registry catalog of operating systems, language runtimes and application base images" chips={[{ label: "Registry catalog", tone: "brand" }]} />
    <input aria-label="Filter base image repositories" placeholder="Filter repositories…" value={filter} onChange={event => setFilter(event.target.value)} className="max-w-md rounded-lg border bg-white px-3 py-2 text-sm" />
    {result?.error && <p className="text-sm text-status-major-label">Catalog unavailable: {result.error}</p>}
    {!result && <p className="text-sm text-muted-foreground">Loading base image catalog…</p>}
    {!!registries.length && <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between"><h2 className="text-sm font-medium">Registry activity</h2><span className="text-xs text-muted-foreground">{result?.data?.observedAt ? `Observed ${new Date(result.data.observedAt).toLocaleTimeString()}` : ""} · refreshes every 15 seconds</span></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{registries.map(status => <div key={status.registry} className="rounded-xl border bg-white p-4">
        <div className="flex items-center justify-between gap-3"><span className="font-mono text-sm">{status.registry}</span><RegistryState status={status} /></div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{status.authentication === "authenticated" ? "Authenticated" : "Anonymous"}</span><span>{status.activeRepositories.length} active repositories</span></div>
        {!!status.activeRepositories.length && <p className="mt-2 truncate text-xs text-muted-foreground" title={status.activeRepositories.join("\n")}>{status.activeRepositories.join(", ")}</p>}
        {status.retryAt && new Date(status.retryAt).getTime() > new Date(result?.data?.observedAt ?? "").getTime() && <p className="mt-2 text-xs">Retry at {new Date(status.retryAt).toLocaleTimeString()}</p>}
        <p className="mt-2 text-xs text-muted-foreground">Last successful scrape: {status.lastSuccess ? compactRelativeTimeFromNow(status.lastSuccess) : "None this run"}</p>
        {status.lastRequest && <p className="mt-1 text-xs text-muted-foreground">Latest request: {compactRelativeTimeFromNow(status.lastRequest)}{status.lastHTTPStatus ? ` · HTTP ${status.lastHTTPStatus}` : ""}</p>}
        {status.lastError && <p className="mt-2 break-words text-xs text-status-major-label">{status.lastError}</p>}
      </div>)}</div>
    </section>}
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="border-b bg-gray-50 text-xs text-muted-foreground"><tr><th className="px-5 py-3">Repository</th><th>Version tags</th><th>Platform images</th><th>Last scrape</th><th>Status</th></tr></thead><tbody>
      {repositories.map(repo => {
        const registry = registries.find(s => s.registry === repo.repository.split("/")[0])
        const live = registry?.state === "throttled" || registry?.activeRepositories.includes(repo.repository)
        return <tr key={repo.repository} className="border-b last:border-0"><td className="px-5 py-4"><Link href={linkTo(repositoryPath(repo.repository))} className="font-mono text-brand-text hover:underline">{repo.repository}</Link></td><td>{repo.matchedTags}</td><td>{repo.imageCount}</td><td>{repo.checkedAt ? compactRelativeTimeFromNow(repo.checkedAt) : "Not scraped yet"}</td><td className="max-w-md py-3 pr-5 text-xs" title={repo.errors?.join("\n")}>{live && registry ? <RegistryState status={registry} /> : repo.errors?.length ? repo.errors[0] : repo.checkedAt ? "Indexed" : "Queued"}{!!repo.skippedTags && <span className="ml-2 text-muted-foreground">{repo.skippedTags} legacy tags skipped</span>}</td></tr>
      })}
    </tbody></table>{result?.data && repositories.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">No matching repositories.</p>}</div>
  </main>
}

function RegistryState({ status }: { status: RegistryStatus }) {
  const color = status.state === "throttled" ? "bg-amber-100 text-amber-800" : status.state === "scraping" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600"
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{status.state}</span>
}
