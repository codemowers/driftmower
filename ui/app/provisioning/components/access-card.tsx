"use client"

import { KeyRound } from "lucide-react"

import { cn } from "@/lib/utils/cn"
import type { NamespaceFact, Verdict } from "@/lib/features/provisioning/types"

// What the cluster authorizer lets you do in each selected namespace, asked as
// you by driftmower-mcp: one SubjectAccessReview per resource type and verb,
// summarised. It reflects every way access is granted (roles, cluster roles,
// groups), which a list of RoleBindings cannot.

const TIERS: { key: "view" | "edit" | "admin"; label: string; meaning: string }[] = [
  { key: "view", label: "See workloads", meaning: "list pods" },
  { key: "edit", label: "Deploy", meaning: "create Deployments" },
  { key: "admin", label: "Grant access", meaning: "create RoleBindings" },
]

const TONE: Record<Verdict, string> = {
  yes: "bg-status-ok-bg text-status-ok-label",
  no: "bg-status-neutral-bg text-status-neutral-label",
  unknown: "bg-status-minor-bg text-status-minor-label",
}

export default function AccessCard({ namespaces }: { namespaces: NamespaceFact[] }) {
  const reported = namespaces.filter(n => n.access)

  if (reported.length === 0) {
    return <p className="text-sm text-muted-foreground">Your access could not be checked for the selected sandbox.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {reported.map(n => {
        const access = n.access!
        const { byVerb, resourceTypes, unknown } = access.summary

        return (
          <div key={n.namespace} className="rounded-lg border border-border bg-card px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="size-4 shrink-0 text-brand-icon" aria-hidden />
              <span className="font-mono text-xs text-muted-foreground">{n.namespace}</span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {TIERS.map(tier => (
                <span
                  key={tier.key}
                  title={`${tier.meaning}: ${access[tier.key]}`}
                  className={cn("rounded-md px-2 py-0.5 text-xs font-medium", TONE[access[tier.key]])}
                >
                  {tier.label}: {access[tier.key] === "unknown" ? "not checked" : access[tier.key]}
                </span>
              ))}
            </div>

            <p className="mt-3 text-sm text-muted-foreground">
              Of the {resourceTypes} resource types this cluster serves, you may create {byVerb.create}, change{" "}
              {byVerb.update} and delete {byVerb.delete} here.
              {unknown > 0 ? ` ${unknown} checks could not be evaluated and count as not checked, not denied.` : ""}
            </p>
          </div>
        )
      })}
    </div>
  )
}
