"use client"

import { Plus, Minus } from "lucide-react"
import type { GraphNode } from "@/lib/features/netstatd"
import { cn } from "@/lib/utils/cn"
import { subtitleText, type Side } from "./graph-layout"

type Props = {
  node: GraphNode
  side: Side | null
  collapsed?: boolean
  expanded?: boolean
  onToggle?: () => void
}

export default function TopologyNode({ node, side, collapsed, expanded, onToggle }: Props) {
  const isPod = node.kind === "pod"
  const isNamespace = node.kind === "namespace"
  const clickable = onToggle !== undefined
  const opened = isNamespace ? !collapsed : expanded

  const Root = clickable ? "button" : "div"

  return (
    <Root
      type={clickable ? "button" : undefined}
      onClick={onToggle}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md px-3 py-[9px] text-left",
        isPod
          ? "bg-brand text-white"
          : "border bg-card transition-colors hover:border-muted-foreground/40",
        !isPod && (node.restricted ? "border-dashed border-muted-foreground/50" : "border-border"),
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span
          className={cn(
            "break-words font-mono text-[13px] leading-[18px]",
            isPod && "font-semibold text-white",
            !isPod && (node.restricted ? "font-medium text-muted-foreground" : "font-semibold text-foreground"),
          )}
        >
          {node.name}
        </span>
        {clickable && (
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {opened ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
          </span>
        )}
      </div>

      <span
        className={cn(
          "break-words font-mono text-[10px] uppercase leading-[14px] tracking-wide",
          isPod ? "text-white/70" : "text-muted-foreground",
        )}
      >
        {subtitleText(node)}
      </span>

      {!isPod && side && (
        <span className="font-mono text-[11px] leading-[16px] tabular-nums text-foreground">
          {countLine(node, side)}
        </span>
      )}

      {expanded && !isNamespace && node.ports.length > 0 && (
        <div className="flex flex-col">
          {node.ports.map((port, i) => (
            <span key={i} className="font-mono text-[9px] leading-[14px] text-muted-foreground">
              {port}
            </span>
          ))}
        </div>
      )}
    </Root>
  )
}

function countLine(node: GraphNode, side: Side): string {
  return side === "in" ? `↓×${compact(node.inCount)}` : `↑×${compact(node.outCount)}`
}

function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
