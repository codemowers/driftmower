"use client"

import { useEffect, useState } from "react"
import { callTool } from "@/browser/connection"
import LoadingLine from "@/app/components/loading-line"
import MarkdownText from "@/app/components/markdown-text"
import { cn } from "@/lib/utils/cn"

type Rule = { apiGroups?: string[]; operations?: string[]; resources?: string[] }
type Policy = {
  name: string
  description: string | null
  kind: "ValidatingAdmissionPolicy" | "MutatingAdmissionPolicy"
  targets?: { resourceRules?: Rule[] }
  conditional: boolean
  bindings: { name: string; validationActions?: string[] }[] | null
}

const CELL = "px-4 py-3 align-top"
const HEAD = "px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"

// One line per resource a policy's rules name, with the group and the
// operations it is checked on.
function targets(p: Policy): string[] {
  const lines: string[] = []
  for (const r of p.targets?.resourceRules ?? []) {
    const groups = (r.apiGroups ?? [""]).map(g => (g === "" ? "" : g === "*" ? ".*" : `.${g}`))
    const ops = (r.operations ?? ["*"]).map(o => o.toLowerCase()).join(", ")
    for (const res of r.resources ?? []) for (const g of groups) lines.push(`${res}${g} (${ops})`)
  }
  return [...new Set(lines)]
}

// What happens to a matching request: a mutating policy rewrites it, a
// validating one denies, warns or audits as its bindings say; unbound does
// nothing.
function effect(p: Policy): { label: string; className: string } {
  if (p.bindings === null) return { label: "Unknown", className: "bg-gray-100 text-muted-foreground" }
  if (p.bindings.length === 0) return { label: "Unbound", className: "bg-gray-100 text-muted-foreground" }
  if (p.kind === "MutatingAdmissionPolicy") return { label: "Mutates", className: "bg-brand-bg text-brand-label" }
  const actions = new Set(p.bindings.flatMap(b => b.validationActions?.length ? b.validationActions : ["Deny"]))
  if (actions.has("Deny")) return { label: "Denies", className: "bg-status-major-bg text-status-major-label" }
  return { label: [...actions].join(", "), className: "bg-status-minor-bg text-status-minor-label" }
}

// Every validating and mutating admission policy, by name.
export default function PolicyTable() {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; policies: Policy[]; unavailable: string[] }>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    callTool<{ policies: Policy[]; unavailableKinds: string[] }>("get_admission_policies")
      .then(r => { if (!cancelled) setState({ status: "ready", policies: [...r.policies].sort((a, b) => a.name.localeCompare(b.name)), unavailable: r.unavailableKinds }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [])

  if (state.status === "loading") return <LoadingLine loading="admission policies" />
  if (state.status === "error") return <p className="text-sm text-muted-foreground">Admission policies could not be loaded: {state.message}</p>
  return (
    <div className="flex flex-col gap-2">
      {state.unavailable.length > 0 && <p className="text-sm text-muted-foreground">Not served by this cluster: {state.unavailable.join(", ")}</p>}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className={HEAD}>Policy</th>
              <th className={HEAD}>Applies to</th>
              <th className={HEAD}>Description</th>
              <th className={HEAD}>Effect</th>
            </tr>
          </thead>
          <tbody>
            {state.policies.map(p => {
              const e = effect(p)
              return (
                <tr key={`${p.kind}/${p.name}`} className="border-t border-gray-100">
                  <td className={CELL}>
                    <code className="block font-mono text-xs text-foreground">{p.name}</code>
                    <span className="text-xs text-muted-foreground">{p.kind === "MutatingAdmissionPolicy" ? "Mutating" : "Validating"}{p.conditional ? " · conditional" : ""}</span>
                  </td>
                  <td className={cn(CELL, "whitespace-nowrap font-mono text-xs text-muted-foreground")}>
                    {targets(p).map(line => <div key={line}>{line}</div>)}
                  </td>
                  <td className={cn(CELL, "min-w-80 text-muted-foreground")}>
                    {p.description ? <MarkdownText text={p.description} /> : "—"}
                  </td>
                  <td className={CELL}>
                    <span className={cn("inline-flex w-fit rounded-md px-2 py-1 text-xs font-medium", e.className)}>{e.label}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
