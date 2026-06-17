"use client"

import { Plus, Minus, Maximize } from "lucide-react"
import { cn } from "@/lib/utils/cn"

type Props = {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}

export default function GraphControls({ onZoomIn, onZoomOut, onFit }: Props) {
  return (
    <div className="absolute bottom-4 right-4 flex flex-col overflow-hidden rounded-md border border-border bg-background">
      <ControlButton label="Zoom in" onClick={onZoomIn}>
        <Plus className="size-4" />
      </ControlButton>
      <ControlButton label="Zoom out" onClick={onZoomOut} className="border-t border-border">
        <Minus className="size-4" />
      </ControlButton>
      <ControlButton label="Fit to view" onClick={onFit} className="border-t border-border">
        <Maximize className="size-4" />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  children,
  label,
  onClick,
  className,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}
