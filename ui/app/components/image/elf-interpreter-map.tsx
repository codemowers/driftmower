"use client"

import { useMemo, useRef, useState } from "react"
import { Minus, Plus, RotateCcw, Scan } from "lucide-react"
import { Button } from "@/components/ui/button"
import Card from "@/app/components/layout/card"
import { useImageAnalysis, type ImageAnalysis } from "@/lib/features/image-analysis"
import { interpreterGroups } from "@/lib/features/elf-interpreters"

type Binary = ImageAnalysis["binaries"][number]

function InterpreterMap({ analysis }: { analysis: ImageAnalysis }) {
  const groups = useMemo(() => interpreterGroups(analysis.binaries ?? []), [analysis.binaries])
  const [view, setView] = useState({ x: 20, y: 20, scale: 0.85 })
  const [picked, setPicked] = useState<Binary | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const layout = groups.map((group, index) => {
    const top = groups.slice(0, index).reduce((sum, prior) => sum + Math.max(3, prior.binaries.length) * 38 + 35, 0)
    return { group, top, center: top + Math.max(3, group.binaries.length) * 19 }
  })
  const height = groups.reduce((sum, group) => sum + Math.max(3, group.binaries.length) * 38 + 35, 0)
  function zoom(factor: number) {
    const width = svg.current?.clientWidth ?? 1000
    setView(v => {
      const scale = Math.max(0.1, Math.min(3, v.scale * factor))
      const ratio = scale / v.scale
      return { scale, x: width / 2 - (width / 2 - v.x) * ratio, y: 280 - (280 - v.y) * ratio }
    })
  }
  return <>
    <p className="text-sm text-muted-foreground">Declared ELF interpreters grouped by architecture. Drag to pan; use the controls to zoom. Select a binary for its full path. Loader names suggest a family; they do not establish a libc version, loader availability or execution.</p>
    {!groups.length ? <p className="text-sm text-muted-foreground">No ELF binary records retained. This does not prove the image has no ELF files.</p> : <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => zoom(1.25)}><Plus />Zoom in</Button>
        <Button variant="outline" size="sm" onClick={() => zoom(0.8)}><Minus />Zoom out</Button>
        <Button variant="outline" size="sm" onClick={() => {
          const scale = Math.min((svg.current?.clientWidth ?? 1000) / 1140, 520 / Math.max(height, 1), 1)
          setView({ x: 20, y: 20, scale })
        }}><Scan />Fit all</Button>
        <Button variant="outline" size="sm" onClick={() => setView({ x: 20, y: 20, scale: 0.85 })}><RotateCcw />Reset</Button>
        <span className="text-xs text-muted-foreground">{Math.round(view.scale * 100)}% · {analysis.binaries.length} retained ELF records</span>
      </div>
      <svg ref={svg} width="100%" height="560" role="group" aria-label="ELF interpreter map. Arrow keys pan; plus and minus zoom. Full paths are also available in the text view below." tabIndex={0}
        className="touch-none cursor-grab text-foreground focus:outline-2 focus:outline-brand"
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          const moves: Record<string, [number, number]> = { ArrowLeft: [50, 0], ArrowRight: [-50, 0], ArrowUp: [0, 50], ArrowDown: [0, -50] }
          if (moves[event.key]) { event.preventDefault(); const [x, y] = moves[event.key]; setView(v => ({ ...v, x: v.x + x, y: v.y + y })) }
          if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.25) }
          if (event.key === "-") { event.preventDefault(); zoom(0.8) }
        }}
        onPointerDown={event => {
          if (event.button !== 0) return
          drag.current = { x: event.clientX, y: event.clientY, moved: false }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          const start = drag.current
          if (!start) return
          const x = event.clientX - start.x, y = event.clientY - start.y
          if (!start.moved && Math.abs(x) + Math.abs(y) < 4) return
          drag.current = { x: event.clientX, y: event.clientY, moved: true }
          setView(v => ({ ...v, x: v.x + x, y: v.y + y }))
        }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
          {layout.map(({ group, top, center }) => <g key={group.key}>
            <text x="0" y={center - 28} fontSize="13" className="fill-current font-semibold">{group.architecture} · {group.binaries.length}</text>
            <text x="0" y={center - 7} fontSize="12" className="fill-current font-mono">{group.label.length > 53 ? `${group.label.slice(0, 50)}…` : group.label}<title>{group.label}</title></text>
            {group.family && <text x="0" y={center + 14} fontSize="12" className="fill-current">{group.family}</text>}
            {group.binaries.map((binary, i) => {
              const y = top + i * 38 + 19
              const select = () => setPicked(binary)
              return <g key={binary.path}>
                <path d={`M 390 ${center} C 440 ${center}, 440 ${y}, 490 ${y}`} fill="none" stroke="currentColor" strokeOpacity="0.25" />
                <g role="button" tabIndex={0} aria-label={`Inspect ${binary.path}`} aria-pressed={picked === binary} className="cursor-pointer"
                  onPointerDown={event => event.stopPropagation()}
                  onClick={select} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select() } }}>
                  <rect x="490" y={y - 15} width="610" height="30" rx="4" className={picked === binary ? "fill-brand-bg stroke-brand" : "fill-white stroke-gray-200"} />
                  <text x="502" y={y + 4} fontSize="12" className="fill-current font-mono">{binary.path.length > 75 ? `…${binary.path.slice(-74)}` : binary.path}</text>
                  <title>{binary.path}</title>
                </g>
              </g>
            })}
          </g>)}
        </g>
      </svg>
      {picked && <div className="text-sm" aria-live="polite">
        <p className="break-all font-mono">Path in image: {picked.path}</p>
        <p>{picked.architecture || "Unknown architecture"} · {picked.linking || "Unknown linking"}</p>
        {picked.interpreter && <p className="break-all font-mono">Declared interpreter: {picked.interpreter}</p>}
        {picked.error && <p className="text-status-major-label">Inspection incomplete: {picked.error}</p>}
      </div>}
      <details className="text-sm"><summary className="cursor-pointer">Text view · full image paths</summary>
        {groups.map(group => <div key={group.key} className="mt-4">
          <p className="break-all font-mono font-semibold">{group.architecture} · {group.label}</p>
          {group.family && <p className="text-xs text-muted-foreground">{group.family}</p>}
          <ul className="mt-2 space-y-1">{group.binaries.map(binary => <li key={binary.path} className="break-all font-mono text-xs">{binary.path}{binary.error && ` · Inspection incomplete: ${binary.error}`}</li>)}</ul>
        </div>)}
      </details>
    </>}
    {(analysis.truncated || analysis.binariesTruncated) && <p className="text-sm text-status-minor-label">Partial coverage: filesystem enumeration or retained ELF records were truncated. Additional binaries and interpreters may be missing.</p>}
    {!!analysis.errors?.length && <details className="text-sm"><summary>Filesystem inspection errors ({analysis.errors.length})</summary>{analysis.errors.map((error, i) => <p key={i} className="break-all">{error}</p>)}</details>}
  </>
}

export default function ElfInterpreterMap({ digest }: { digest: string }) {
  const result = useImageAnalysis([digest], true)
  const artifacts = result.data?.images[digest]
  return <Card title="ELF interpreter map">
    {result.error ? <p role="alert" className="text-sm text-status-major-label">Image analysis unavailable: {result.error}</p>
      : !artifacts ? <p className="text-sm text-muted-foreground">Loading ELF evidence…</p>
      : !artifacts.length ? <p className="text-sm text-muted-foreground">No image analysis available.</p>
      : artifacts.map(artifact => <div key={artifact.digest} className="flex min-w-0 flex-col gap-4">
        {artifacts.length > 1 && <p className="break-all font-mono text-xs">Platform artifact: {artifact.digest}</p>}
        {artifact.analysis ? <InterpreterMap key={artifact.digest} analysis={artifact.analysis} />
          : <p className="text-sm text-muted-foreground">{artifact.status === "pending" ? "Awaiting image analysis." : "Image analysis expired or unavailable."}</p>}
      </div>)}
  </Card>
}
