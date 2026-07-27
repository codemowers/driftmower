"use client"

import { useEffect, useState } from "react"
import { Check, Copy, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import CopyButton from "@/app/components/copy-button"
import { cn } from "@/lib/utils/cn"
import { emitYamlLines, yamlText, type YamlLine } from "@/lib/utils/yaml-lines"

const LINE_HEIGHT_PX = 20
const MAX_PATH_CHARS = 110

type Props = {
  uid: string
  kind: string
  namespace: string
  name: string
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; lines: YamlLine[] }

function displayPath(path: string): string {
  if (path.length <= MAX_PATH_CHARS) return path
  return `…${path.slice(path.length - MAX_PATH_CHARS + 1)}`
}

const KEY_LINE = /^(\s*(?:- )?)([^:\s][^:]*):(\s.*)?$/

function LineText({ text }: { text: string }) {
  const match = KEY_LINE.exec(text)
  if (!match) return <span className="text-foreground">{text}</span>
  const [, prefix, key, rest] = match
  return (
    <span className="text-foreground">
      {prefix}
      <span className="text-brand-label">{key}</span>
      {`:${rest ?? ""}`}
    </span>
  )
}

export default function YamlViewer({ uid, kind, namespace, name }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [scopeIndex, setScopeIndex] = useState(0)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const query = new URLSearchParams({ kind, namespace, name })

    fetch(`/api/cluster-resources/${encodeURIComponent(uid)}/yaml?${query}`, { cache: "no-store" })
      .then(async res => {
        if (cancelled) return
        const json = await res.json()
        if (!res.ok) {
          setState({ status: "error", message: json.error ?? `Request failed with status ${res.status}` })
          return
        }
        setState({ status: "ready", lines: emitYamlLines(json) })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [uid, kind, namespace, name])

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading YAML…</p>
  }

  if (state.status === "error") {
    return <p className="text-sm text-status-major-label">Failed to load YAML: {state.message}</p>
  }

  const { lines } = state
  const scrollScopePath = lines[Math.min(scopeIndex, lines.length - 1)]?.path ?? ""
  const scopePath = hoveredIndex !== null ? lines[hoveredIndex]?.path ?? scrollScopePath : scrollScopePath
  const text = yamlText(lines)

  function handleCopy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleDownload() {
    const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `${name}.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Scope
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-brand-text" title={scopePath}>
          {displayPath(scopePath)}
        </span>
        {scopePath && <CopyButton value={scopePath} className="shrink-0" />}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy YAML"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleDownload}>
            <Download aria-hidden />
            Download
          </Button>
        </div>
      </div>

      <div
        className="h-[calc(100vh-17rem)] min-h-96 overflow-auto bg-gray-50 py-2 font-mono text-xs"
        onScroll={e => setScopeIndex(Math.max(0, Math.floor(e.currentTarget.scrollTop / LINE_HEIGHT_PX)))}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <div className="w-max min-w-full">
          {lines.map((line, i) => (
            <div
              key={i}
              style={{ height: LINE_HEIGHT_PX }}
              className={cn(
                "flex items-center whitespace-pre px-4",
                hoveredIndex === i && "bg-brand-bg",
              )}
              onMouseEnter={() => setHoveredIndex(i)}
              onClick={() => navigator.clipboard.writeText(line.path)}
            >
              <LineText text={line.text} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
