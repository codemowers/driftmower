"use client"

import { useState } from "react"
import Link from "next/link"
import { useParams, useSearchParams } from "next/navigation"
import { Layers } from "lucide-react"
import ResourceHeader from "@/app/components/resource-header"
import CopyButton from "@/app/components/copy-button"
import BaseImageHierarchy from "@/app/components/image/base-image-hierarchy"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useRegistryQuery } from "@/lib/features/base-images/use-registry-query"
import { platformName, preferredTag, repositoryPath, type BaseImage, type RepositoryPage } from "@/lib/features/base-images/types"
import { callRegistry } from "@/browser/catalog"

function ImageDetails({ image }: { image: BaseImage }) {
  const [error, setError] = useState("")
  async function downloadConfig() {
    try {
      const result = await callRegistry<{ gzipBase64: string }>("get_base_image_config", { digest: image.configDigest })
      const bytes = Uint8Array.from(atob(result.gzipBase64), char => char.charCodeAt(0))
      const blob = new Blob([bytes], { type: "application/gzip" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a"); link.href = url; link.download = "config.json.gz"; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) { setError((error as Error).message) }
  }
  return <>
    <BaseImageHierarchy images={[image]} targetLabel={`${image.repository}:${preferredTag(image.tags)}`} />
    <section className="rounded-xl border bg-white p-6"><h2 className="mb-4 text-sm font-semibold">Image configuration</h2><dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-[140px_1fr]">
      <dt className="text-muted-foreground">Platform</dt><dd className="font-mono">{platformName(image.platform)}</dd>
      <dt className="text-muted-foreground">Manifest</dt><dd className="flex min-w-0 items-center gap-2 break-all font-mono">{image.digest}<CopyButton value={image.digest} /></dd>
      <dt className="text-muted-foreground">Config digest</dt><dd className="break-all font-mono">{image.configDigest}</dd>
      <dt className="text-muted-foreground">Built</dt><dd>{image.created ?? "Not declared"}</dd>
      <dt className="text-muted-foreground">Entrypoint</dt><dd className="break-all font-mono">{JSON.stringify(image.entrypoint ?? [])}</dd>
      <dt className="text-muted-foreground">Command</dt><dd className="break-all font-mono">{JSON.stringify(image.cmd ?? [])}</dd>
      <dt className="text-muted-foreground">Working directory</dt><dd className="font-mono">{image.workingDir || "/"}</dd>
      <dt className="text-muted-foreground">User</dt><dd className="font-mono">{image.user || "0"}</dd>
      <dt className="text-muted-foreground">Observed tags</dt><dd className="break-all font-mono text-xs">{image.tags.join(", ")}</dd>
      <dt className="text-muted-foreground">Current tags</dt><dd className="break-all font-mono text-xs">{image.currentTags?.length ? image.currentTags.join(", ") : "Historical image; tags have moved or were removed"}</dd>
    </dl><button onClick={() => void downloadConfig()} className="mt-5 rounded border px-3 py-2 text-sm hover:bg-gray-50">Download config.json.gz</button>{error && <p className="mt-2 text-sm text-status-major-label">{error}</p>}</section>
    <section className="rounded-xl border bg-white p-6"><h2 className="mb-4 text-sm font-semibold">Labels and annotations</h2><dl className="grid gap-2 text-xs sm:grid-cols-[minmax(180px,1fr)_2fr]">{Object.entries({ ...image.annotations, ...image.labels }).map(([key, value]) => <div key={key} className="contents"><dt className="break-all font-mono text-muted-foreground">{key}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl></section>
    <section className="overflow-x-auto rounded-xl border bg-white p-6"><h2 className="mb-4 text-sm font-semibold">Ordered filesystem layers</h2><ol className="space-y-3">{image.layers.map((layer, index) => <li key={index} className="text-xs"><p className="font-semibold">Layer {index + 1} · {layer.size.toLocaleString()} bytes</p><p className="break-all font-mono">{layer.digest}</p><p className="break-all font-mono text-muted-foreground">DiffID {layer.diffID ?? "unknown"}</p></li>)}</ol></section>
  </>
}

export default function BaseImageRepositoryPage() {
  const params = useParams<{ image: string[] }>()
  const repository = (params.image ?? []).map(decodeURIComponent).join("/").replace(/\/$/, "")
  const search = useSearchParams()
  const selectedDigest = search.get("digest") ?? ""
  const offset = Math.max(0, Number(search.get("offset")) || 0)
  const { linkTo } = useContextHref()
  const result = useRegistryQuery<RepositoryPage>("get_base_image_repository", { repository, offset: selectedDigest ? 0 : offset, limit: 50, ...(selectedDigest ? { digest: selectedDigest } : {}) })
  const page = result?.data
  const selected = selectedDigest ? page?.images.find(image => image.digest === selectedDigest) : undefined
  return <main className="flex w-full flex-col gap-6 px-7 py-12">
    <ResourceHeader icon={Layers} iconAriaLabel="Base image repository" title={repository.split("/").at(-1) ?? repository} copyValue={repository} breadcrumbs={[{ label: "Base Images", href: linkTo("/base-images") }, { label: repository, ...(selectedDigest ? { href: linkTo(repositoryPath(repository)) } : {}) }, ...(selectedDigest ? [{ label: selectedDigest.slice(7, 19) }] : [])]} subtitle={repository} chips={[{ label: "Registry catalog", tone: "brand" }]} />
    {result?.error && <p className="text-sm text-status-major-label">Catalog unavailable: {result.error}</p>}
    {!result && <p className="text-sm text-muted-foreground">Loading registry metadata…</p>}
    {page?.errors?.length ? <div className="rounded-lg border p-4 text-sm"><p className="font-semibold">Scrape incomplete</p>{page.errors.slice(0, 5).map((error, i) => <p key={i} className="mt-1 text-muted-foreground">{error}</p>)}</div> : null}
    {selected ? <ImageDetails image={selected} /> : page && <>
      <p className="text-sm text-muted-foreground">{page.imageCount} platform images · {page.matchedTags} accepted version tags · {page.checkedAt ? `last scraped ${page.checkedAt}` : "waiting for first scrape"}</p>
      {selectedDigest && <p className="text-sm text-muted-foreground">This manifest is no longer in the current catalog. <Link className="text-brand-text hover:underline" href={linkTo(repositoryPath(repository))}>Browse the repository</Link></p>}
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="border-b bg-gray-50 text-xs text-muted-foreground"><tr><th className="px-5 py-3">Version</th><th>Platform</th><th>Built</th><th>Layers</th><th>Digest</th></tr></thead><tbody>{page.images.map(image => <tr key={image.digest + platformName(image.platform)} className="border-b last:border-0"><td className="px-5 py-4"><Link href={linkTo(repositoryPath(repository), { set: { digest: image.digest } })} className="font-mono text-brand-text hover:underline" title={image.tags.join(", ")}>{preferredTag(image.tags)}</Link>{image.tags.length > 1 && <p className="mt-1 text-xs text-muted-foreground">{image.tags.length} aliases</p>}</td><td className="pr-4 font-mono text-xs">{platformName(image.platform)}</td><td className="pr-4 text-xs">{image.created ?? "Not declared"}</td><td>{image.layers.length}</td><td className="pr-5 font-mono text-xs">{image.digest.slice(0, 19)}…</td></tr>)}</tbody></table></div>
      <div className="flex items-center gap-4 text-sm">{offset > 0 && <Link href={linkTo(repositoryPath(repository), { set: { offset: String(Math.max(0, offset - 50)) } })} className="text-brand-text hover:underline">Previous</Link>}<span className="text-muted-foreground">{page.total ? offset + 1 : 0}–{Math.min(offset + page.images.length, page.total)} of {page.total}</span>{offset + page.images.length < page.total && <Link href={linkTo(repositoryPath(repository), { set: { offset: String(offset + 50) } })} className="text-brand-text hover:underline">Next</Link>}</div>
    </>}
  </main>
}
