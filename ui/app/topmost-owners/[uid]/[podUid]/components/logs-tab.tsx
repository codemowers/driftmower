"use client"

import { type ReactNode, type WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils/cn"
import type { ClusterResource, PodContainerStatus } from "@/lib/cluster/cluster-state"
import { BOTTOM_THRESHOLD_PX } from "@/lib/features/logs/constants"
import { formatLogTime } from "@/lib/features/logs/line"
import type { LogLine } from "@/lib/features/logs/types"
import type { Severity } from "@/lib/features/logs/parse"
import { useLogs } from "../hooks/use-logs"

// The logs of one Pod; with no pod, of the whole workload; with neither, of
// the whole namespace: every Pod and container merged in time order.
type Props = {
  namespace: string
  workloadUid?: string
  pod?: ClusterResource
}

export default function LogsTab({ namespace, workloadUid, pod }: Props) {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [follow, setFollow] = useState(true)

  const statuses = pod?.podStatus?.containers ?? []
  const relevant = selected ? statuses.filter(c => c.name === selected) : statuses

  const { lines, source, selector, containers, error, notice, loaded } = useLogs(namespace, workloadUid, pod?.name, selected, follow)

  const paneRef = useRef<HTMLDivElement>(null)
  const programmaticRef = useRef(false)

  const scrollToBottom = useCallback(() => {
    const el = paneRef.current
    if (!el) return
    programmaticRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      programmaticRef.current = false
    })
  }, [])

  useLayoutEffect(() => {
    if (follow) scrollToBottom()
  }, [lines, follow, scrollToBottom])

  useEffect(() => {
    paneRef.current?.focus({ preventScroll: true })
  }, [])

  function onScroll() {
    if (programmaticRef.current) return
    const el = paneRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX
    if (follow && !atBottom) setFollow(false)
  }

  function onWheel(e: WheelEvent) {
    if (follow && e.deltaY < 0) setFollow(false)
  }

  function handleFollowChange(value: boolean) {
    setFollow(value)
    if (value) scrollToBottom()
  }

  // A namespace's logs are always every container of every Pod.
  const wholeNamespace = !workloadUid && !pod
  const multi = containers.length > 1
  // The Container heading carries the container picker, so the column stays
  // while there is more than one to pick from.
  const showContainer = wholeNamespace || multi
  const showPod = wholeNamespace || (!pod && new Set(lines.map(l => l.pod)).size > 1)
  const markers = pod ? restartMarkers(relevant, notice) : []

  const fresh = useFreshLines(lines, loaded)

  const header = (
    <div className={cn(ROW, "sticky top-0 z-10 -mx-3 items-center border-b border-gray-200 bg-white px-3 py-1.5 font-sans text-[10px] font-semibold uppercase tracking-wider text-muted-foreground")}>
      <span>Time</span>
      {showPod && <span>Pod</span>}
      {showContainer && (multi && !wholeNamespace
        ? <span className="normal-case tracking-normal"><ContainerSelect containers={containers} selected={selected} onSelect={setSelected} /></span>
        : <span>Container</span>)}
      <span>Severity</span>
      <span className="flex items-center gap-3">
        Message
        <span className="ml-auto font-mono text-[10px] font-normal normal-case tracking-normal">{source && !pod && selector === "labels" ? `${source} · by labels` : source ?? ""}</span>
        <label className="flex cursor-pointer items-center gap-2 normal-case tracking-normal text-foreground">
          Follow
          <Switch checked={follow} onCheckedChange={handleFollowChange} />
        </label>
      </span>
    </div>
  )

  return (
    <div
      ref={paneRef}
      onScroll={onScroll}
      onWheel={onWheel}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto rounded-md border border-gray-200 bg-white font-mono text-xs leading-snug outline-none"
    >
      <div className="grid gap-x-3 px-3" style={{ gridTemplateColumns: gridColumns(showPod, showContainer) }}>
        {header}
        {error ? (
          <p className="col-span-full py-3 text-muted-foreground">{error}</p>
        ) : !loaded ? (
          <p className="col-span-full py-3 text-muted-foreground">Loading logs…</p>
        ) : lines.length === 0 ? (
          <p className="col-span-full py-3 text-muted-foreground">{pod ? emptyMessage(pod, relevant, notice) : notice ?? "No logs to display."}</p>
        ) : renderLines(lines, markers, showContainer, showPod, fresh)}
      </div>
    </div>
  )
}

const FADE_MS = 2500

// Lines that arrived after the first load, kept until their highlight has
// faded.
function useFreshLines(lines: LogLine[], loaded: boolean): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!loaded) return
    if (seen.current === null) {
      seen.current = new Set(lines.map(l => l.key))
      return
    }
    const added = lines.map(l => l.key).filter(k => !seen.current!.has(k))
    if (added.length === 0) return
    for (const k of added) seen.current.add(k)
    setFresh(prev => new Set([...prev, ...added]))
    // Each batch is dropped on its own schedule, even when more arrive.
    setTimeout(() => setFresh(prev => new Set([...prev].filter(k => !added.includes(k)))), FADE_MS)
  }, [lines, loaded])
  return fresh
}

type Marker = { tsMs: number; container: string; label: string; detail: string | null }

function restartMarkers(statuses: PodContainerStatus[], notice: string | null): Marker[] {
  return statuses
    .flatMap(c => {
      const finishedAt = c.lastTerminated?.finishedAt
      if (!c.lastTerminated || !finishedAt) return []
      const tsMs = Date.parse(finishedAt)
      if (!Number.isFinite(tsMs)) return []
      return [{
        tsMs,
        container: c.name,
        label: `Restarted · exited ${c.lastTerminated.exitCode} · ${c.lastTerminated.reason}`,
        detail: notice ? `previous run unavailable: ${notice}` : null,
      }]
    })
    .sort((a, b) => a.tsMs - b.tsMs)
}

const SEVERITY_STYLE: Record<Severity, string> = {
  fatal: "bg-status-major-bg text-status-major-label",
  error: "bg-status-major-bg text-status-major-label",
  warn: "bg-status-minor-bg text-status-minor-label",
  info: "bg-gray-100 text-muted-foreground",
  debug: "text-muted-foreground/70",
}

// Columns: runtime time, then pod and container when several, severity and
// message; the line's own timestamp is not repeated. Rows share the pane's
// grid, so every column lines up.
function gridColumns(showPod: boolean, showContainer: boolean): string {
  return ["max-content", showPod && "minmax(0,14rem)", showContainer && "minmax(0,10rem)", "3.5rem", "minmax(0,1fr)"].filter(Boolean).join(" ")
}

const ROW = "col-span-full grid grid-cols-subgrid"

function renderLines(lines: LogLine[], markers: Marker[], showContainer: boolean, showPod: boolean, fresh: Set<string>): ReactNode[] {
  const out: ReactNode[] = []
  let next = 0
  const pushMarker = () => {
    const marker = markers[next++]
    out.push(<MarkerRow key={`marker-${marker.container}-${marker.tsMs}`} marker={marker} showContainer={showContainer} />)
  }
  lines.forEach((line, i) => {
    while (next < markers.length && line.tsMs > markers[next].tsMs) pushMarker()
    const { severity, message, fields } = line.parsed
    out.push(
      <div key={line.key} className={cn(ROW, "-mx-3 px-3 py-px", i % 2 === 1 && "bg-gray-100/70", fresh.has(line.key) && "log-line-new")}>
        <span className="tabular-nums text-muted-foreground">{formatLogTime(line.tsMs)}</span>
        {showPod && <span className="truncate text-muted-foreground" title={line.pod}>{line.pod}</span>}
        {showContainer && <span className="truncate text-muted-foreground" title={line.container}>{line.container}</span>}
        <span>{severity && <span className={cn("rounded px-1 text-[10px] font-semibold uppercase", SEVERITY_STYLE[severity])}>{severity}</span>}</span>
        <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
          {message}
          {fields.length > 0 && <span className="text-muted-foreground">{fields.map(([k, v]) => ` ${k}=${v}`).join("")}</span>}
        </span>
      </div>,
    )
  })
  while (next < markers.length) pushMarker()
  return out
}

function MarkerRow({ marker, showContainer }: { marker: Marker; showContainer: boolean }) {
  return (
    <div className="col-span-full my-1.5 border-t border-gray-200 pt-1.5 text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="shrink-0 tabular-nums">{formatLogTime(marker.tsMs)}</span>
        {showContainer && <span className="shrink-0">{marker.container}</span>}
        <span className="font-medium">{marker.label}</span>
      </div>
      {marker.detail && <div className="mt-0.5 break-words">{marker.detail}</div>}
    </div>
  )
}

function emptyMessage(pod: ClusterResource, statuses: PodContainerStatus[], notice: string | null): string {
  const neverStarted = statuses.find(c => c.waiting && c.restartCount === 0 && !c.lastTerminated)
  if (neverStarted?.waiting) {
    // The reason alone is a category, not a diagnosis: CreateContainerConfigError
    // is equally "that Secret does not exist" and "this image's USER is a name,
    // so the kubelet cannot prove it is non-root". The kubelet says which in the
    // message, and we already carry it — so print it rather than sending the
    // reader to kubectl describe for the half of the answer that matters.
    const { reason, message } = neverStarted.waiting
    return message
      ? `No logs: the container never started (${reason}). ${message}`
      : `No logs: the container never started (${reason}).`
  }
  if (pod.podStatus?.display === "Evicted") {
    const detail = pod.podStatus.message ? ` ${pod.podStatus.message}` : ""
    return `No logs: the pod was evicted.${detail}`
  }
  if (notice) return `No logs from the current run. Previous run unavailable: ${notice}`
  if (statuses.some(c => c.lastTerminated)) return "No logs from the current or the previous run."
  return "No logs to display."
}

const ALL_LABEL = "All"

type ContainerSelectProps = {
  containers: string[]
  selected: string | undefined
  onSelect: (container: string | undefined) => void
}

function ContainerSelect({ containers, selected, onSelect }: ContainerSelectProps) {
  const [open, setOpen] = useState(false)

  function pick(container: string | undefined) {
    onSelect(container)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 font-mono text-xs text-foreground transition-colors hover:bg-gray-50">
        {selected ?? ALL_LABEL}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-0.5 p-2">
        <Row active={selected === undefined} label={ALL_LABEL} onClick={() => pick(undefined)} />
        {containers.map(container => (
          <Row key={container} active={selected === container} label={container} onClick={() => pick(container)} />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function Row({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left font-mono text-xs transition-colors",
        active ? "bg-brand-bg text-brand-label" : "text-foreground hover:bg-brand-bg/50",
      )}
    >
      <Check className={cn("size-3.5 shrink-0", active ? "text-brand" : "opacity-0")} />
      <span className="truncate">{label}</span>
    </button>
  )
}
