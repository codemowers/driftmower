"use client"
import CopyButton from "./copy-button"

export default function CommandSnippet({ title, command, open = false, fullHeight = false }: { title: string; command: string; open?: boolean; fullHeight?: boolean }) {
  return <details open={open} className="rounded-lg border bg-gray-50">
    <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium">{title}<CopyButton value={command} /></summary>
    <pre className={`${fullHeight ? "" : "max-h-72 "}overflow-auto border-t p-3 text-xs`}><code>{command}</code></pre>
  </details>
}
