"use client"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import CopyButton from "../../components/copy-button"
import { cn } from "@/lib/utils/cn"

const VISIBLE = 2

export function ValuePill({ value, copyable }: { value: string; copyable?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
      {value}
      {copyable && <CopyButton value={value} className="relative z-10 shrink-0" />}
    </span>
  )
}

type Props = {
  values: string[]
  label: string
  copyable?: boolean
  promote?: string
}

export default function OverflowPills({ values, label, copyable, promote }: Props) {
  if (values.length === 0) return <span className="text-gray-400">&mdash;</span>

  const ordered = promote
    ? [...values].sort((a, b) => {
      const match = (v: string) => (v.toLowerCase().includes(promote.toLowerCase()) ? 0 : 1)
      return match(a) - match(b)
    })
    : values

  const shown = ordered.slice(0, VISIBLE)
  const hidden = ordered.length - shown.length

  return (
    <span className="flex flex-nowrap items-center gap-1.5">
      {shown.map(value => (
        <ValuePill key={value} value={value} copyable={copyable} />
      ))}
      {hidden > 0 && (
        <Popover>
          <span
            className="contents"
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            <PopoverTrigger
              className={cn(
                "relative z-10 shrink-0 cursor-pointer rounded-full bg-brand-bg px-2.5 py-1 font-mono text-xs font-semibold text-brand outline-none",
                "focus-visible:ring-3 focus-visible:ring-ring/50",
              )}
            >
              +{hidden}
            </PopoverTrigger>
          </span>
          <PopoverContent align="start" className="w-64 gap-0 p-2">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{values.length}</span>
            </div>
            <div className="max-h-80 overflow-y-auto pr-1.5">
              {ordered.map(value => (
                <div
                  key={value}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-brand-bg/50"
                >
                  <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{value}</span>
                  {copyable && <CopyButton value={value} className="shrink-0" />}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  )
}
