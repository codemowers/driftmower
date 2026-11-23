import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import { SEVERITY_STYLE } from "@/lib/cluster/styles/status-style"
import CopyButton from "@/app/components/copy-button"

const CELL_LABEL = "text-xs font-semibold uppercase tracking-wider text-muted-foreground"

export function StatGrid({ children, columns = 4, vertical = false }: { children: ReactNode; columns?: 3 | 4; vertical?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className={cn("grid divide-gray-200", vertical ? "grid-cols-1 divide-y" : columns === 3 ? "grid-cols-3 divide-x" : "grid-cols-4 divide-x")}>{children}</div>
    </div>
  )
}

export function StatCell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5 px-5 py-5", className)}>
      <p className={CELL_LABEL}>{label}</p>
      {children}
    </div>
  )
}

export function StatValue({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xl font-semibold tabular-nums text-foreground mt-0.5", className)}>{children}</p>
}

export function StatCaption({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

export function NamespaceCell({
  namespace,
  worstStatus,
}: {
  namespace: string
  worstStatus: StatusType
}) {
  const worstStyle = SEVERITY_STYLE[worstStatus]
  return (
    <div className="flex flex-col gap-2 px-5 py-5">
      <p className={CELL_LABEL}>Namespace</p>
      <div className="flex items-center gap-1.5">
        <p className="font-mono text-md font-semibold text-foreground">{namespace}</p>
        <CopyButton value={namespace} />
      </div>
      <div className="flex items-center gap-1">
        <p className="text-xs text-muted-foreground">Worst:</p>
        {worstStyle ? (
          <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", worstStyle.bg, worstStyle.text)}>
            {worstStyle.label}
          </span>
        ) : (
          <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-muted-foreground">
            No data
          </span>
        )}
      </div>
    </div>
  )
}
