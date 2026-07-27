"use client"

import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Check, Copy, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import CopyButton from "@/app/components/copy-button"
import { cn } from "@/lib/utils/cn"
import { yamlText, type YamlLine } from "@/lib/utils/yaml-lines"

const LINE_HEIGHT_PX = 20
const MAX_PATH_CHARS = 110
const WINDOW_THRESHOLD = 2000
const OVERSCAN_LINES = 20

type Props = {
  lines: YamlLine[]
  filename: string
  toolbar?: ReactNode
  footer?: ReactNode
  className?: string
  paneClassName?: string
}

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

export default function DocumentViewer({ lines, filename, toolbar, footer, className, paneClassName }: Props) {
  const paneRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [paneHeight, setPaneHeight] = useState(0)
  const [scopeIndex, setScopeIndex] = useState(0)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    setPaneHeight(paneRef.current?.clientHeight ?? 0)
  }, [])

  const windowed = lines.length > WINDOW_THRESHOLD
  const firstIndex = windowed ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT_PX) - OVERSCAN_LINES) : 0
  const windowSize = windowed ? Math.ceil(paneHeight / LINE_HEIGHT_PX) + OVERSCAN_LINES * 2 : lines.length
  const rendered = lines.slice(firstIndex, firstIndex + windowSize)
  const padBottom = (lines.length - firstIndex - rendered.length) * LINE_HEIGHT_PX

  const hasPaths = lines.some(line => line.path)
  const scrollScopePath = lines[Math.min(scopeIndex, lines.length - 1)]?.path ?? ""
  const scopePath = hoveredIndex !== null ? lines[hoveredIndex]?.path ?? scrollScopePath : scrollScopePath
  const text = yamlText(lines)

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    setScrollTop(e.currentTarget.scrollTop)
    setPaneHeight(e.currentTarget.clientHeight)
    setScopeIndex(Math.max(0, Math.floor(e.currentTarget.scrollTop / LINE_HEIGHT_PX)))
  }

  function handleCopy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleDownload() {
    const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }))
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const actions = (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy YAML"}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={handleDownload}>
        <Download aria-hidden />
        Download YAML
      </Button>
    </div>
  )

  return (
    <div className={cn("overflow-hidden rounded-xl border border-gray-200 bg-white", className)}>
      {toolbar && (
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5">
          {toolbar}
          {actions}
        </div>
      )}

      {(hasPaths || !toolbar) && (
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5">
          {hasPaths && (
            <>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Scope
              </span>
              <span className="min-w-0 truncate font-mono text-xs text-brand-text" title={scopePath}>
                {displayPath(scopePath)}
              </span>
              {scopePath && <CopyButton value={scopePath} className="shrink-0" />}
            </>
          )}
          {!toolbar && actions}
        </div>
      )}

      <div
        ref={paneRef}
        className={cn("h-[calc(100vh-17rem)] min-h-96 overflow-auto bg-gray-50 py-2 font-mono text-xs", paneClassName)}
        onScroll={handleScroll}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <div className="w-max min-w-full">
          <div style={{ height: firstIndex * LINE_HEIGHT_PX }} />
          {rendered.map((line, i) => {
            const index = firstIndex + i
            return (
              <div
                key={index}
                style={{ height: LINE_HEIGHT_PX }}
                className={cn(
                  "flex items-center whitespace-pre px-4",
                  line.tone === "set" && "bg-brand-bg",
                  hoveredIndex === index && "bg-brand-bg",
                )}
                onMouseEnter={() => setHoveredIndex(index)}
              >
                <LineText text={line.text} />
                {line.note && <span className="ml-6 italic text-muted-foreground">{line.note}</span>}
              </div>
            )
          })}
          <div style={{ height: Math.max(0, padBottom) }} />
        </div>
      </div>

      {footer && (
        <div className="flex items-center gap-2 border-t border-gray-200 px-4 py-2 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  )
}
