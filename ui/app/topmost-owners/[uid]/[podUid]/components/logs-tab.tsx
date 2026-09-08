"use client"

import { type ReactNode, type WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils/cn"
import type { ClusterResource, PodContainerStatus } from "@/lib/cluster/cluster-state"
import { fetchContainers } from "@/lib/features/logs/fetch"
import { BOTTOM_THRESHOLD_PX } from "@/lib/features/logs/constants"
import { formatLogTime } from "@/lib/features/logs/line"
import type { LogLine, LogSource } from "@/lib/features/logs/types"
import { useLogs } from "../hooks/use-logs"

type Props = {
  pod: ClusterResource
}

export default function LogsTab({ pod }: Props) {
  const { namespace: ns, name, uid } = pod
  const [containers, setContainers] = useState<string[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchContainers(ns, name).then(c => {
      if (!cancelled) setContainers(c)
    })
    return () => {
      cancelled = true
    }
  }, [ns, name])

  const statuses = pod.podStatus?.containers ?? []
  const relevant = selected ? statuses.filter(c => c.name === selected) : statuses
  const hasPreviousRun = relevant.some(c => c.lastTerminated !== null)

  const { lines, source, error, notice, loaded } = useLogs(ns, name, uid, selected, follow, hasPreviousRun)

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

  const multi = containers.length > 1
  const showContainer = multi && selected === undefined
  const markers = restartMarkers(relevant, notice)

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
      <LogsToolbar
        containers={containers}
        selected={selected}
        onSelect={setSelected}
        showSelect={multi}
        singleName={multi ? undefined : containers[0]}
        source={source}
        follow={follow}
        onFollowChange={handleFollowChange}
      />
      <div
        ref={paneRef}
        onScroll={onScroll}
        onWheel={onWheel}
        tabIndex={0}
        className="h-[60vh] overflow-auto bg-gray-50 px-4 py-3 font-mono text-xs leading-snug outline-none"
      >
        {error ? (
          <p className="text-muted-foreground">{error}</p>
        ) : !loaded ? (
          <p className="text-muted-foreground">Loading logs…</p>
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground">{emptyMessage(pod, relevant, notice)}</p>
        ) : (
          renderLines(lines, markers, showContainer)
        )}
      </div>
    </div>
  )
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

function renderLines(lines: LogLine[], markers: Marker[], showContainer: boolean): ReactNode[] {
  const out: ReactNode[] = []
  let next = 0
  const pushMarker = () => {
    const marker = markers[next++]
    out.push(<MarkerRow key={`marker-${marker.container}-${marker.tsMs}`} marker={marker} showContainer={showContainer} />)
  }
  for (const line of lines) {
    while (next < markers.length && line.tsMs > markers[next].tsMs) pushMarker()
    out.push(
      <div key={line.key} className="flex gap-3">
        <span className="shrink-0 tabular-nums text-muted-foreground">{formatLogTime(line.tsMs)}</span>
        {showContainer && <span className="shrink-0 text-muted-foreground">{line.container}</span>}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{line.message}</span>
      </div>,
    )
  }
  while (next < markers.length) pushMarker()
  return out
}

function MarkerRow({ marker, showContainer }: { marker: Marker; showContainer: boolean }) {
  return (
    <div className="my-1.5 border-t border-gray-200 pt-1.5 text-muted-foreground">
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
  if (neverStarted?.waiting) return `No logs: the container never started (${neverStarted.waiting.reason}).`
  if (pod.podStatus?.display === "Evicted") {
    const detail = pod.podStatus.message ? ` ${pod.podStatus.message}` : ""
    return `No logs: the pod was evicted.${detail}`
  }
  if (notice) return `No logs from the current run. Previous run unavailable: ${notice}`
  if (statuses.some(c => c.lastTerminated)) return "No logs from the current or the previous run."
  return "No logs to display."
}

type LogsToolbarProps = {
  containers: string[]
  selected: string | undefined
  onSelect: (container: string | undefined) => void
  showSelect: boolean
  singleName?: string
  source: LogSource | null
  follow: boolean
  onFollowChange: (value: boolean) => void
}

function LogsToolbar({
  containers,
  selected,
  onSelect,
  showSelect,
  singleName,
  source,
  follow,
  onFollowChange,
}: LogsToolbarProps) {
  return (
    <div className="flex items-center gap-4 border-b border-gray-200 px-4 py-2.5">
      {showSelect ? (
        <ContainerSelect containers={containers} selected={selected} onSelect={onSelect} />
      ) : (
        <span className="font-mono text-xs text-foreground">{singleName ?? "—"}</span>
      )}

      <span className="ml-auto font-mono text-xs text-muted-foreground">{source ?? ""}</span>

      <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
        Follow
        <Switch checked={follow} onCheckedChange={onFollowChange} />
      </label>
    </div>
  )
}

const ALL_LABEL = "All containers"

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
