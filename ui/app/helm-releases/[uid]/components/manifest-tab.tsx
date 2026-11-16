"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import DocumentViewer from "@/app/components/document-viewer"
import TabMessage from "./tab-message"
import { callTool } from "@/browser/connection"
import type { ReleaseInfo } from "@/lib/cluster/reports"
import { cn } from "@/lib/utils/cn"
import { textLines } from "@/lib/features/yaml/yaml-lines"

type ManifestDocument = {
  index: number
  kind: string
  name: string
  source: string
  lineCount: number
  text: string
}

type ManifestIndex = {
  documents: ManifestDocument[]
  totalLines: number
}

type Props = {
  releaseInfo: ReleaseInfo
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; index: ManifestIndex }

export default function ManifestTab({ releaseInfo }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [selected, setSelected] = useState(0)
  const { namespace, name } = releaseInfo
  const documents = state.status === "ready" ? state.index.documents : []

  useEffect(() => {
    let cancelled = false
    callTool<ManifestIndex>("get_helm_release", { namespace, name })
      .then(index => { if (!cancelled) setState({ status: "ready", index }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [namespace, name])

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

  function downloadManifest() {
    const text = documents.map(d => (d.source ? `# Source: ${d.source}\n${d.text}` : d.text)).join("\n---\n")
    const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }))
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
          lines={textLines(active.text)}
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
