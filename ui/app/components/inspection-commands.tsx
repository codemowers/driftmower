"use client"
import type { ReactNode } from "react"
import CopyButton from "./copy-button"

export { shellQuote } from "@/lib/utils/shell"

export default function InspectionCommands({ commands, children }: {
  commands: { label: string; command: string }[]
  children?: ReactNode
}) {
  if (!commands.length) return null
  return <details className="rounded-xl border border-gray-200 bg-white p-5">
    <summary className="cursor-pointer text-sm font-semibold">Inspect with kubectl</summary>
    <p className="mt-3 text-xs text-muted-foreground">Commands name the kubeconfig context explicitly. Replace &lt;context&gt; if no desktop connection is selected. Your kubectl permissions apply.</p>
    {children}
    <div className="mt-4 flex flex-col gap-4">{commands.map(({ label, command }) => <div key={command}>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-3 rounded bg-gray-50 p-3"><code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">{command}</code><CopyButton value={command}/></div>
    </div>)}</div>
  </details>
}
