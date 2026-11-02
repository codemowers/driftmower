import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils/cn"
import type { Sandbox, SandboxStatus } from "../data"

const STATUS_STYLE: Record<SandboxStatus, { bg: string; text: string; label: string }> = {
  ready:        { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "Ready" },
  provisioning: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Provisioning" },
  expired:      { bg: "bg-gray-100",        text: "text-muted-foreground",   label: "Expired" },
}

export default function CreateSandbox({
  sandboxes,
  className,
}: {
  sandboxes: Sandbox[]
  className?: string
}) {
  return (
    <div className={cn("flex flex-col rounded-xl border border-gray-200 bg-white", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Verify before you ship</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deploy the bundle to an ephemeral sandbox and confirm it installs clean.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-gray-200 bg-white hover:bg-gray-50"
        >
          Create sandbox
        </Button>
      </div>

      <div className="divide-y divide-gray-100">
        {sandboxes.map(s => {
          const style = STATUS_STYLE[s.status]
          return (
            <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-foreground">{s.name}</p>
                <p className="text-xs text-muted-foreground">k8s {s.k8sVersion}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {s.status === "expired" ? "expired" : s.ttl}
                </span>
                <span className={cn("rounded-md px-3 py-1.5 text-xs font-semibold", style.bg, style.text)}>
                  {style.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
