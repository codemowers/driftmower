"use client"
import { useCallback, useState } from "react"
import { Download } from "lucide-react"
import Card from "@/app/components/layout/card"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useQuery } from "@/lib/hooks/use-query"
import { downloadSbom, loadSbom } from "@/browser/image-scans"
import { sbomComponents } from "@/lib/features/vulnerability/licenses"
import LicenseBadge from "@/app/components/license-badge"

// Components of one image digest with their licenses on the right. The full
// SBOM is downloaded only here.
export default function ImageSbom({ digest }: { digest: string }) {
  const cluster = useClusterState(state => state.clusterName)
  const load = useCallback(async () => {
    const boms = await loadSbom(digest)
    return { components:sbomComponents(boms), incomplete:boms.some(b => b.properties?.some(p => p.name === "driftmower:scan:vulnerabilities-status" && p.value !== "complete")) }
  }, [digest])
  const result = useQuery({ key: cluster ? JSON.stringify([cluster, "sbom", digest]) : null, load })
  const components = result.data?.components
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const download = <button type="button" onClick={() => { setDownloadError(null); downloadSbom(digest).catch((e: Error) => setDownloadError(e.message)) }}
    className="inline-flex items-center gap-1 text-xs text-brand-text hover:underline"><Download className="size-3.5" />CycloneDX JSON</button>
  return <Card flush title="Components" meta={components && <span className="tabular-nums">{components.length}</span>} actions={components && download}>
    {result.data?.incomplete && <p role="status" className="border-b px-5 py-3 text-sm text-muted-foreground">Filesystem evidence is available. Vulnerability coverage is unknown for one or more platforms.</p>}
    {downloadError && <p role="alert" className="border-b px-5 py-3 text-sm text-status-major-label">SBOM download failed: {downloadError}</p>}
    {result.error ? <p className="px-5 py-4 text-sm text-muted-foreground">SBOM unavailable: {result.error}</p>
      : !components ? <p className="px-5 py-4 text-sm text-muted-foreground">Loading SBOM…</p>
      : !components.length ? <p className="px-5 py-4 text-sm text-muted-foreground">The SBOM lists no components.</p>
      : <ul className="divide-y">{components.map(c => <li key={c.key} className="flex items-start gap-4 px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm"><span className="font-medium">{c.name}</span>{c.version && <span className="ml-2 font-mono text-xs text-muted-foreground">{c.version}</span>}{(c.image || c.type) && <span className="ml-2 text-xs text-muted-foreground">{c.image ? "image" : c.type}</span>}</p>
          {c.type === "file" && <p className="mt-1 text-xs text-muted-foreground">
            {[c.mimeType, c.modifiedAt && `modified ${new Date(c.modifiedAt).toLocaleString()}`, c.linking && `ELF: ${c.linking}`].filter(Boolean).join(" · ")}
          </p>}
          {c.purl && <p className="break-all font-mono text-xs text-muted-foreground">{c.purl}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">{c.licenses.length ? c.licenses.map((l, i) => <LicenseBadge key={i} license={{ spdxId: l.id, name: l.name ?? l.expression, url: l.url }} />) : <span className="text-xs text-muted-foreground">no license</span>}</div>
      </li>)}</ul>}
  </Card>
}
