"use client"

import { OctagonX, ShieldCheck } from "lucide-react"

import { cn } from "@/lib/utils/cn"
import type { AdmissionFact } from "@/lib/features/provisioning/types"

// Admission policies override RBAC, so these are the rules that actually
// decide whether an apply succeeds — regardless of what your role says.
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_110px] items-start gap-4"

export default function AdmissionList({ policies }: { policies: AdmissionFact[] }) {
  if (policies.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No admission policies are installed, so nothing beyond your own permissions restricts what you can
        create here.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-2.5")}>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Policy</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Applies to</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Effect</span>
      </div>

      {policies.map(policy => (
        <div key={policy.name} className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-3 last:border-b-0")}>
          <code className="font-mono text-xs text-foreground">{policy.name}</code>

          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs text-muted-foreground">
              {policy.guards.map(g => `${g.resource} (${g.operations.join(", ").toLowerCase()})`).join("; ")}
            </span>
            {/* Every message, not just the first: a policy often carries a
                specific rule and a blanket one, and only the blanket one
                explains why an apply failed. */}
            {policy.messages.map(message => (
              <span key={message} className="text-sm text-muted-foreground">
                {message}
              </span>
            ))}
          </div>

          <span
            className={cn(
              "inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
              policy.enforced
                ? "bg-status-major-bg text-status-major-label"
                : "bg-status-neutral-bg text-status-neutral-label",
            )}
          >
            {policy.enforced ? <OctagonX className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
            {policy.enforced ? "Denies" : "Records"}
          </span>
        </div>
      ))}
    </div>
  )
}
