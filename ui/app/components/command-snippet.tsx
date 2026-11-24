"use client"
import type { ReactNode } from "react"
import CopyButton from "./copy-button"

export default function CommandSnippet({ title, command, open = false, fullHeight = false, collapsible = true }: { title: ReactNode; command: string; open?: boolean; fullHeight?: boolean; collapsible?: boolean }) {
  if (!collapsible) return <div className="min-w-0 space-y-2">
    <div className="flex items-center justify-between gap-3 text-xs font-medium"><span>{title}</span><CopyButton value={command} /></div>
    <pre className={`${fullHeight ? "" : "max-h-72 "}overflow-auto bg-gray-50 p-3 text-xs`}><code>{command}</code></pre>
  </div>
  return <details open={open} className="rounded-lg border bg-gray-50">
    <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium"><span>{title}</span><CopyButton value={command} /></summary>
    <pre className={`${fullHeight ? "" : "max-h-72 "}overflow-auto border-t p-3 text-xs`}><code>{command}</code></pre>
  </details>
}
