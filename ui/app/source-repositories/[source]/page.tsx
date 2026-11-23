"use client"

import { useCallback } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"
import Card from "@/app/components/layout/card"
import { imagePath } from "@/lib/utils/image-artifacts"
import { sourceFindings, sourceImages } from "@/browser/catalog"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { safeSourceURL, type SourceRecord } from "@/lib/features/crawler/sources"
import ResourceHeader from "@/app/components/resource-header"
import SourceScrapeBadge from "@/app/components/source-scrape-badge"
import LicenseBadge from "@/app/components/license-badge"
import { classifyLicense } from "@/lib/features/crawler/license"
import CopyButton from "@/app/components/copy-button"
import { ReleaseList } from "@/app/components/image/source-findings"

// registry/repository of a reference, without tag or digest.
function imageKey(ref: string): string {
  return ref.split("@")[0].replace(/:[^/]*$/, "")
}

export default function SourceRepositoryDetail() {
  const { source: url } = useParams<{ source: string }>()
  const cluster = useClusterState(s => s.clusterName)
  const { linkTo } = useContextHref()
  const load = useCallback(async (signal: AbortSignal) => {
    const [catalog, images] = await Promise.all([sourceFindings<{ sources: SourceRecord[] }>({ url }, signal), sourceImages(url, signal)])
    return { source: catalog.sources.find(source => source.url === url), ...images }
  }, [url])
  const result = useQuery({ key: JSON.stringify([cluster, "source", url]), load, interval: 30_000 })
  const source = result.data?.source, href = safeSourceURL(url)
  const license = classifyLicense(source?.license)
  const data = useClusterState(s => s.data)
  // Image pages exist only for repositories in the running inventory.
  const inventory = new Set((data?.report.imageUsages ?? []).map(u => `${u.imageInfo.registry}/${u.imageInfo.repository}`))
  const runningImages = new Map<string, string[]>()
  for (const image of result.data?.images ?? []) {
    if (image.unused || !image.version) continue
    runningImages.set(image.version, [...(runningImages.get(image.version) ?? []), imageKey(image.image ?? image.name)])
  }
  return <Page>
    <ResourceHeader icon={ICONS.sources} iconAriaLabel="Source repository" title={url.replace(/^https?:\/\//, "")} copyValue={url} breadcrumbs={[{ label: "Source Repositories", href: linkTo("/source-repositories") }, { label: url.replace(/^https?:\/\//, "") }]} subtitle={href ? <a className="text-brand-text hover:underline" href={href} target="_blank" rel="noreferrer">Open upstream repository</a> : url} />
    {result.loading && <p className="text-sm text-muted-foreground">Loading source repository…</p>}
    {result.error && <p role="alert" className="text-sm text-status-major-label">Source repository unavailable: {result.error} <button className="underline" onClick={result.retry}>Retry</button></p>}
    {result.data && <>
      <div className="flex flex-wrap items-center gap-3"><SourceScrapeBadge scrape={source} />{source?.latest && <span className="font-mono text-sm">Latest release: {source.latest.tag}</span>}</div>
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Repository license">
            <LicenseBadge license={source?.license} />
            <p className="text-sm">{license.title}</p>
            <p className="text-xs text-muted-foreground">Classification: {license.classification}{license.osi && license.classification !== "OSI approved" ? " · OSI approved" : ""}</p>
            {safeSourceURL(source?.license?.url) && <a className="text-sm text-brand-text hover:underline" href={source!.license!.url} target="_blank" rel="noreferrer">Read license</a>}
          </Card>
          <Card flush title="Changelog" meta={source?.releases?.length || undefined}>
            {source?.releases?.length
              ? <ReleaseList releases={source.releases} deployedVersions={source.deployed.map(version => version.version)} runningImages={runningImages} />
              : <p className="px-5 py-4 text-sm text-muted-foreground">{source?.unauthorized ? "Unauthorized: crawler credentials cannot access this repository. See scrape errors for details." : source?.errors?.some(error => error.startsWith("releases:")) ? "Release versions could not be loaded because the release crawl failed." : "No release versions collected from the source repository."}</p>}
          </Card>
          {!!source?.errors?.length && <Card title="Scrape errors">{source.errors.map(error => <p key={error} className="break-words text-xs text-status-major-label">{error}</p>)}</Card>}
        </div>
        <Card title="Images built from this repository" meta={result.data.images.length} flush>
          <p className="border-b border-gray-100 px-5 py-3 text-xs text-muted-foreground">ContainerImages recorded in this cluster, including unused images and images without version labels. Only images in the running inventory have an image page.</p>
          <ul className="divide-y divide-gray-100">{result.data.images.map(image => {
            const ref = image.image ?? image.name
            const key = imageKey(ref)
            const linked = inventory.has(key)
            const tags = image.references.filter(r => !r.includes("@"))
            const digests = image.references.filter(r => r.includes("@"))
            return <li key={image.name} className="flex flex-col gap-1.5 px-5 py-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {linked
                  ? <Link href={linkTo(`/container-images/${imagePath(key)}`)} className="break-all font-mono text-brand-text hover:underline">{key}</Link>
                  : <span className="break-all font-mono">{key}</span>}
                <CopyButton value={ref} />
                <span className="flex-1" />
                {image.version && <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{image.version}</span>}
                <span className={image.unused ? "rounded bg-gray-100 px-1.5 py-0.5 text-xs text-muted-foreground" : "rounded bg-brand-bg px-1.5 py-0.5 text-xs font-semibold text-brand-label"}>{image.unused ? "unused" : "in use"}</span>
              </div>
              {tags.length > 0 && <div className="flex flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-xs" title={tag}>{tag.slice(tag.lastIndexOf(":") + 1)}</span>)}</div>}
              {(digests.length ? digests.map(d => d.slice(d.indexOf("@") + 1)) : image.digest ? [image.digest] : []).filter((d, i, all) => all.indexOf(d) === i).map(d => <p key={d} className="break-all font-mono text-xs text-muted-foreground">{d}</p>)}
            </li>
          })}</ul>
          {!result.data.images.length && <p className="px-5 py-4 text-sm text-muted-foreground">No images from this repository have been observed.</p>}
        </Card>
      </div>
    </>}
  </Page>
}
