"use client"

import CopyButton from "./copy-button"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import { scopeActionCommand } from "@/lib/kubernetes/contexts"

// A copyable command; kubectl commands get the selected connection's context.
export default function CommandRow({ label, value }: { label: string; value: string }) {
  const connection = useKubectlConnection()
  value = scopeActionCommand(value, connection)
  return (
    <div className="flex items-center gap-3 rounded-lg bg-gray-100 px-3 py-2">
      <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground">
        {value}
      </code>
      <CopyButton value={value} className="shrink-0" />
    </div>
  )
}
