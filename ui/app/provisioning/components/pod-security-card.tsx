"use client"

import { ShieldAlert } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import type { NamespaceFact } from "@/lib/features/provisioning/types"

// Pod Security Admission is enforced by the apiserver itself, so it shows up in
// no policy listing — yet on a restricted namespace it rejects a pod that sets
// no securityContext at all, which is what a first attempt looks like.
const SNIPPET = `securityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault
containers:
  - name: app
    image: <your image>
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]`

export default function PodSecurityCard({ namespaces }: { namespaces: NamespaceFact[] }) {
  const enforcing = namespaces.filter(n => n.podSecurity && n.podSecurity.enforce !== "privileged")
  if (enforcing.length === 0) return null

  // The level is per namespace but almost always uniform, so lead with the
  // shared requirement and only enumerate namespaces when they disagree.
  const levels = new Set(enforcing.map(n => n.podSecurity!.enforce))
  const uniform = levels.size === 1 ? enforcing[0].podSecurity! : null

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-status-minor-label" />
        <span className="text-sm font-medium text-foreground">
          Pod Security Admission&nbsp;
          <code className="font-mono text-xs text-brand-label">
            {uniform ? uniform.enforce : [...levels].join(", ")}
          </code>
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        {uniform
          ? uniform.summary
          : "These namespaces enforce different pod security levels; check each before deploying."}
      </p>

      {!uniform && (
        <div className="flex flex-col gap-1">
          {enforcing.map(n => (
            <span key={n.namespace} className="font-mono text-xs text-muted-foreground">
              {n.namespace} — {n.podSecurity!.enforce}
            </span>
          ))}
        </div>
      )}

      {uniform && uniform.requires.length > 0 && (
        <>
          <div className="flex flex-col gap-1">
            {uniform.requires.map(field => (
              <code key={field} className="font-mono text-xs text-foreground">
                {field}
              </code>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">A pod spec that satisfies all four:</span>
            <span className="relative z-10">
              <CopyButton value={SNIPPET} />
            </span>
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {SNIPPET}
          </pre>
        </>
      )}
    </div>
  )
}
