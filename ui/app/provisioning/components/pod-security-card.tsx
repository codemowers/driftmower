"use client"

import { ShieldAlert } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import type { NamespaceFact } from "@/lib/features/provisioning/types"

// Pod Security Admission is enforced by the apiserver itself, so it shows up in
// no policy listing — yet on a restricted namespace it rejects a pod that sets
// no securityContext at all, which is what a first attempt looks like.
//
// runAsUser is in the snippet even though PSA does not require it, because
// runAsNonRoot has a second enforcement point the requirement list cannot
// describe: admission passes, and then the KUBELET refuses any image whose
// USER is a name rather than a uid, because it cannot prove a name is not
// root. The pod is admitted and never starts, with
// `CreateContainerConfigError` and "image has non-numeric user". Whether it
// bites depends on the image, which this page does not know — so the snippet
// carries the field as a blank to fill in, like the image above it.
const SNIPPET = `securityContext:
  runAsNonRoot: true
  # Your image's own uid. Required whenever its USER is a name (\`USER app\`)
  # rather than a number: the kubelet cannot verify a name is non-root and
  # refuses to start the container. Read it from the image's Dockerfile.
  runAsUser: <uid>
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
          <p className="text-xs text-muted-foreground">
            <code className="font-mono text-xs text-foreground">runAsUser</code> is not one of the four —
            admission does not ask for it. But with{" "}
            <code className="font-mono text-xs text-foreground">runAsNonRoot</code> set, the kubelet refuses
            to start an image whose <code className="font-mono text-xs text-foreground">USER</code> is a name
            instead of a uid, so the pod is admitted and then sits in{" "}
            <code className="font-mono text-xs text-foreground">CreateContainerConfigError</code>.
          </p>
        </>
      )}
    </div>
  )
}
