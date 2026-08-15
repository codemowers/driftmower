"use client"

import { useState, type MouseEvent, type ReactNode } from "react"
import { layOutBands, layOutMarks, withMinWidth, type LaidOutBand, type LaidOutMark } from "@/lib/cluster/drift-history/bands"
import { BAND_STYLE } from "@/lib/cluster/drift-history/band-style"
import { axisDate } from "@/lib/cluster/drift-history/format"
import type { Span, VersionMark } from "@/lib/cluster/drift-history/types"
import { cn } from "@/lib/utils/cn"

type Props = {
  spans: Span[]
  marks?: VersionMark[]
  windowStart: number
  windowEnd: number
  className?: string
}

type Readout = { x: number; y: number; band: LaidOutBand; marks: LaidOutMark[] }

const CURSOR_OFFSET = 5

function TipRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-5">
      <span className="text-background/60">{label}</span>
      <span className="font-mono tabular-nums">{children}</span>
    </div>
  )
}

function DateRange({ from, to }: { from: number; to: number }) {
  const start = axisDate(from)
  const end = axisDate(to)
  if (start === end) return <>{start}</>
  return (
    <>
      {start} <span className="text-background/60">to</span> {end}
    </>
  )
}

export default function StatusTimelineStrip({ spans, marks, windowStart, windowEnd, className }: Props) {
  const [readout, setReadout] = useState<Readout | null>(null)
  const bands = withMinWidth(layOutBands(spans, windowStart, windowEnd))
  const positioned = layOutMarks(marks ?? [], windowStart, windowEnd)

  function track(event: MouseEvent<HTMLDivElement>) {
    const hit = (event.target as HTMLElement).closest<HTMLElement>("[data-band]")
    const band = hit ? bands[Number(hit.dataset.band)] : undefined
    if (!band) {
      setReadout(null)
      return
    }
    setReadout({
      x: event.clientX,
      y: event.currentTarget.getBoundingClientRect().top,
      band,
      marks: positioned.filter(mark => mark.t >= band.from && mark.t <= band.to),
    })
  }

  return (
    <div className={cn("relative", className)}>
      <div
        onMouseMove={track}
        onMouseLeave={() => setReadout(null)}
        className="relative isolate h-[26px] overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--color-border)]"
      >
        {bands.map((band, i) => {
          const style = BAND_STYLE[band.s]
          return (
            <div
              key={i}
              data-band={i}
              className={cn("absolute inset-y-0", style.bg, band.raised && "z-10")}
              style={{
                left: `${band.left}%`,
                width: `${band.renderWidth}%`,
                boxShadow: `inset 0 -3px 0 ${style.baseline}`,
              }}
            />
          )
        })}
      </div>

      {positioned.map((mark, i) => (
        <div
          key={`${mark.kind}-${mark.t}-${i}`}
          className={cn(
            "pointer-events-none absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2",
            mark.kind === "deploy"
              ? "rounded-full bg-foreground/45"
              : "border-l-2 border-dashed border-foreground/35",
            )}
          style={{ left: `${mark.left}%` }}
        />
      ))}

      {readout && (
        <div
          className="pointer-events-none fixed z-50 w-fit max-w-xs -translate-x-1/2 -translate-y-full"
          style={{ left: readout.x, top: readout.y - CURSOR_OFFSET }}
        >
          <div className="flex flex-col gap-0.5 rounded-md bg-foreground px-3 py-2 text-xs text-background">
            <div className="flex items-baseline justify-between gap-5">
              <span className="flex items-center gap-1.5 font-semibold">
                {readout.band.s !== "void" && (
                  <i
                    className={cn("inline-block size-2.5 shrink-0 rounded-[2px]", BAND_STYLE[readout.band.s].bg)}
                    style={{ boxShadow: `inset 0 -2px 0 ${BAND_STYLE[readout.band.s].baseline}` }}
                  />
                )}
                {BAND_STYLE[readout.band.s].label}
              </span>
              <span className="font-mono tabular-nums">
                <DateRange from={readout.band.from} to={readout.band.to} />
              </span>
            </div>

            {readout.band.v && <TipRow label="Running">{readout.band.v}</TipRow>}
            {readout.band.l && readout.band.l !== readout.band.v && (
              <TipRow label="Latest">{readout.band.l}</TipRow>
            )}

            {readout.marks.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5 border-t border-background/20 pt-1.5">
                {readout.marks.map((mark, m) => (
                  <TipRow
                    key={m}
                    label={`${axisDate(mark.t)} · ${mark.kind === "deploy" ? "Deployed" : "Upstream"}`}
                  >
                    {mark.v}
                  </TipRow>
                ))}
              </div>
            )}
          </div>
          <div className="mx-auto size-2.5 -translate-y-1/2 rotate-45 rounded-[2px] bg-foreground" />
        </div>
      )}
    </div>
  )
}
