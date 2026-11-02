"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import DocumentViewer from "@/app/components/document-viewer"
import TabMessage from "./tab-message"
import { HELM_RELEASES_URL } from "@/lib/cluster/constants"
import type { ReleaseInfo } from "@/lib/cluster/reports"
import { cn } from "@/lib/utils/cn"
import { textLines } from "@/lib/features/yaml/yaml-lines"
import { readApiError } from "@/lib/utils/read-api-error"

type ManifestDocumentSummary = {
  index: number
  kind: string
  name: string
  source: string
  lineCount: number
}

type ManifestIndex = {
  documents: ManifestDocumentSummary[]
  totalLines: number
}

type Props = {
  uid: string
  releaseInfo: ReleaseInfo
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; index: ManifestIndex }

export default function ManifestTab({ uid, releaseInfo }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [selected, setSelected] = useState(0)
  const [loaded, setLoaded] = useState<{ index: number; text: string } | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const { namespace, name } = releaseInfo
  const documents = state.status === "ready" ? state.index.documents : []
  const base = `${HELM_RELEASES_URL}/${encodeURIComponent(uid)}/manifest`
  const query = new URLSearchParams({ namespace, name }).toString()

  useEffect(() => {
    let cancelled = false

    fetch(`${base}?${query}`, { cache: "no-store" })
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          const message = await readApiError(res)
          if (!cancelled) setState({ status: "error", message })
          return
        }
        const json = await res.json()
        setState({ status: "ready", index: json })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [base, query])

  useEffect(() => {
    if (!documents.length) return
    let cancelled = false

    fetch(`${base}?${query}&doc=${selected}`, { cache: "no-store" })
      .then(async res => {
        if (!res.ok) throw new Error(await readApiError(res))
        return res.json()
      })
      .then(json => {
        if (!cancelled) setLoaded({ index: selected, text: json.text ?? "" })
      })
      .catch((e: Error) => {
        if (!cancelled) setLoaded({ index: selected, text: `# Could not load this document: ${e.message}` })
      })

    return () => {
      cancelled = true
    }
  }, [base, query, selected, documents.length])

  if (state.status === "loading") {
    return <TabMessage>Loading manifest…</TabMessage>
  }

  if (state.status === "error") {
    return <TabMessage tone="error">Failed to load manifest: {state.message}</TabMessage>
  }

  const { totalLines } = state.index

  if (!documents.length) {
    return <TabMessage>This release rendered no manifest.</TabMessage>
  }

  const active = documents[Math.min(selected, documents.length - 1)]

  async function downloadManifest() {
    const res = await fetch(`${base}?${query}&doc=all`, { cache: "no-store" })
    if (!res.ok) {
      setDownloadError(await readApiError(res))
      return
    }
    setDownloadError(null)
    const json = await res.json()
    const url = URL.createObjectURL(new Blob([json.text ?? ""], { type: "application/yaml" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `${name}-manifest.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5">
        <span className="text-xs text-muted-foreground">
          {documents.length} documents · {totalLines} lines
        </span>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={downloadManifest}>
          <Download aria-hidden />
          Download manifest
        </Button>
      </div>
      {downloadError && (
        <p className="border-b border-gray-200 px-4 py-2 text-xs text-status-major-text">Download failed: {downloadError}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="border-b border-gray-200 md:border-b-0 md:border-r">
          <div className="flex min-h-15 items-center border-b border-gray-200 px-4 py-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Documents
            </span>
          </div>
          <div className="flex max-h-96 flex-col gap-1 overflow-auto p-2 md:h-[calc(100vh-17rem)] md:max-h-none">
            {documents.map(document => (
              <button
                key={document.index}
                type="button"
                onClick={() => setSelected(document.index)}
                aria-pressed={document.index === active.index}
                title={document.name}
                className={cn(
                  "w-full shrink-0 cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors",
                  document.index === active.index ? "bg-brand-bg" : "hover:bg-gray-100",
                )}
              >
                <span
                  className={cn(
                    "block text-[10px] font-semibold uppercase tracking-wider",
                    document.index === active.index ? "text-brand-label" : "text-muted-foreground",
                  )}
                >
                  {document.kind}
                </span>
                <span className="mt-1 block truncate text-sm text-foreground">{document.name}</span>
              </button>
            ))}
          </div>
        </div>

        <DocumentViewer
          key={active.index}
          lines={textLines(loaded?.index === active.index ? loaded.text : "")}
          filename={`${name}-${active.kind}-${active.name}.yaml`}
          className="rounded-none border-0"
          toolbar={
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-xs font-semibold text-foreground" title={active.name}>
                  {active.name}
                </span>
                <span className="shrink-0 rounded-md bg-brand-bg px-2 py-0.5 text-xs font-semibold text-brand-text">
                  {active.kind}
                </span>
              </div>
              {active.source && (
                <span className="truncate text-xs text-muted-foreground">rendered from {active.source}</span>
              )}
            </div>
          }
        />
      </div>
    </div>
  )
}
