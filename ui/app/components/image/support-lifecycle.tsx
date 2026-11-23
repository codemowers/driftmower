"use client"

import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow, isoDate } from "@/lib/utils/format-time"
import type { ImageUsage } from "@/lib/cluster/reports"

type Tone = "ok" | "minor" | "major"

const TONE_TEXT: Record<Tone, string> = {
  ok:    "text-status-ok-label",
  minor: "text-status-minor-label",
  major: "text-status-major-label",
}

const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000

function eolTone(iso: string): Tone {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return "ok"
  if (ms < Date.now()) return "major"
  if (ms - Date.now() < SIX_MONTHS_MS) return "minor"
  return "ok"
}

function activeSupportTone(iso: string): Tone {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return "ok"
  return ms < Date.now() ? "minor" : "ok"
}

function Row({ label, date, tone }: { label: string; date?: string; tone: (iso: string) => Tone }) {
  return (
    <>
      <p className="text-sm text-gray-600">{label}</p>
      <div className="min-w-0 font-mono text-sm">
        {date ? (
          <span>
            <span className="text-foreground">{isoDate(date)}</span>
            <span className={cn("ml-1.5", TONE_TEXT[tone(date)])}>· {relativeTimeFromNow(date)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">not published</span>
        )}
      </div>
    </>
  )
}

export default function SupportLifecycle({ usage }: { usage: ImageUsage }) {
  const { endOfLifeDate, endOfActiveSupportDate } = usage.imageInfo
  if (!endOfLifeDate && !endOfActiveSupportDate) return null

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <p className="-mx-5 mb-4 border-b border-gray-200 px-5 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Support lifecycle
      </p>

      <div className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-4">
        <Row label="Support ends" date={endOfActiveSupportDate} tone={activeSupportTone} />
        <Row label="End of life" date={endOfLifeDate} tone={eolTone} />
      </div>
    </div>
  )
}
