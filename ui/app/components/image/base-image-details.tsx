"use client"

import { useState } from "react"
import Card from "@/app/components/layout/card"
import CopyButton from "@/app/components/copy-button"
import { useRegistryQuery } from "@/lib/features/base-images/use-registry-query"
import { platformName, preferredTag, type RepositoryDetail } from "@/lib/features/base-images/types"
import { callRegistry } from "@/browser/catalog"

// One scraped catalog image: configuration, labels and ordered layers.
export default function BaseImageDetails({ repository, digest }: { repository: string; digest: string }) {
  const result = useRegistryQuery<RepositoryDetail>("get_base_image_repository", { repository, digest })
  const image = result?.data?.images.find(i => i.digest === digest)
  const [error, setError] = useState("")
  async function downloadConfig() {
    if (!image) return
    try {
      const out = await callRegistry<{ gzipBase64: string }>("get_base_image_config", { digest: image.configDigest })
      const bytes = Uint8Array.from(atob(out.gzipBase64), char => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }))
      const link = document.createElement("a"); link.href = url; link.download = "config.json.gz"; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) { setError((e as Error).message) }
  }
  if (result?.error) return <Card title="Base image"><p className="text-sm text-muted-foreground">Catalog unavailable: {result.error}</p></Card>
  if (!image) return <Card title="Base image"><p className="text-sm text-muted-foreground">{result?.data ? "This image is no longer in the catalog." : "Loading registry metadata…"}</p></Card>
  const labels = Object.entries({ ...image.annotations, ...image.labels })
  return <>
    <Card title={`${repository}:${preferredTag(image.tags)}`} actions={<button type="button" onClick={() => void downloadConfig()} className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">Download config.json.gz</button>}>
      <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-[140px_1fr]">
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
      </dl>
      {error && <p role="alert" className="text-sm text-status-major-label">{error}</p>}
    </Card>
    {labels.length > 0 && <Card title="Labels and annotations">
      <dl className="grid gap-2 text-xs sm:grid-cols-[minmax(180px,1fr)_2fr]">{labels.map(([key, value]) => <div key={key} className="contents"><dt className="break-all font-mono text-muted-foreground">{key}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl>
    </Card>}
    <Card title="Ordered filesystem layers" meta={`${image.layers?.length ?? 0}`}>
      <ol className="space-y-3">{(image.layers ?? []).map((layer, index) => <li key={index} className="text-xs"><p className="font-semibold">Layer {index + 1} · {layer.size.toLocaleString()} bytes</p><p className="break-all font-mono">{layer.digest}</p><p className="break-all font-mono text-muted-foreground">DiffID {layer.diffID ?? "unknown"}</p></li>)}</ol>
    </Card>
  </>
}
