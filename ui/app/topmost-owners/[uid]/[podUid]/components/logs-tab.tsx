"use client"

import { type WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils/cn"
import { fetchContainers } from "@/lib/features/logs/fetch"
import { BOTTOM_THRESHOLD_PX } from "@/lib/features/logs/constants"
import { formatLogTime } from "@/lib/features/logs/line"
import type { LogSource } from "@/lib/features/logs/types"
import { useLogs } from "../hooks/use-logs"

type Props = {
  ns: string
  pod: string
  uid: string
}

export default function LogsTab({ ns, pod, uid }: Props) {
  const [containers, setContainers] = useState<string[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchContainers(ns, pod).then(c => {
      if (!cancelled) setContainers(c)
    })
    return () => {
      cancelled = true
    }
  }, [ns, pod])

  const { lines, source, error } = useLogs(ns, pod, uid, selected, follow)

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
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground">No logs to display.</p>
        ) : (
          lines.map(line => (
            <div key={line.key} className="flex gap-3">
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatLogTime(line.tsMs)}</span>
              {showContainer && (
                <span className="shrink-0 text-muted-foreground">{line.container}</span>
              )}
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
                {line.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
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
