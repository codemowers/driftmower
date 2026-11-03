"use client"

import { Globe } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import type { IngressFact } from "@/lib/features/provisioning/types"

function ingressSnippet(host: string, namespace: string, ingressClass: string): string {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: ${namespace}
spec:
  ingressClassName: ${ingressClass}
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80`
}

// The answer to "what hostname may I use", which is the question that started
// this feature. A sandbox id begins with a hash assigned at creation, so this
// cannot be guessed — it has to be shown.
export default function HostCard({ ingress }: { ingress: IngressFact }) {
  if (ingress.domainSuffix === null && ingress.hostRules.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No ingress domain is published for this cluster, so ask the platform team which hostnames you may
        use.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {ingress.hostRules.map(rule => (
        <div key={rule.namespace} className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="size-4 shrink-0 text-brand-icon" />
            <span className="font-mono text-xs text-muted-foreground">{rule.namespace}</span>
            {/* The hostnames anchor on the sandbox id, which is not the
                namespace name — sandbox abc123-demo lives in namespace
                sb-abc123-demo. Without saying so, the prefix below looks like
                a typo. */}
            {(rule.tenantId ?? rule.sandboxId) && (rule.tenantId ?? rule.sandboxId) !== rule.namespace && (
              <span className="text-xs text-muted-foreground">
                sandbox <code className="font-mono text-brand-label">{rule.tenantId ?? rule.sandboxId}</code>
              </span>
            )}
          </div>

          {rule.exactHost ? (
            <div className="mt-3 flex flex-col gap-2">
              <HostRow host={rule.exactHost} />
              {rule.labelledPattern && <HostRow host={rule.labelledPattern} pattern />}
            </div>
          ) : null}

          <p className="mt-3 text-sm text-muted-foreground">{rule.note}</p>

          {/* The guard's own words. A user who gets the hostname wrong would
              otherwise meet this message for the first time in their terminal. */}
          {rule.enforcedMessage && (
            <p className="mt-2 text-sm text-status-minor-label">
              Rejected hosts fail with: {rule.enforcedMessage}
            </p>
          )}

          {/* Built from the host the guard will actually accept, so it can be
              pasted instead of reassembled out of the prose above. */}
          {rule.exactHost && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">An Ingress that would be accepted:</span>
                <span className="relative z-10">
                  <CopyButton value={ingressSnippet(rule.exactHost, rule.namespace, defaultClass(ingress))} />
                </span>
              </div>
              <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {ingressSnippet(rule.exactHost, rule.namespace, defaultClass(ingress))}
              </pre>
            </div>
          )}
        </div>
      ))}

      {ingress.classes.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Use <code className="font-mono text-xs text-brand-label">ingressClassName: {defaultClass(ingress)}</code>
          {ingress.tlsAdvice ? ` — ${ingress.tlsAdvice}` : null}
        </p>
      )}
    </div>
  )
}

function defaultClass(ingress: IngressFact): string {
  // A cluster that reports no classes still needs a placeholder rather than a
  // crash: the snippet is a starting point, not a promise.
  return (ingress.classes.find(c => c.isDefault) ?? ingress.classes[0])?.name ?? "<ingress class>"
}

// A concrete hostname is copyable; a pattern is not, since <label> is a
// placeholder the user has to replace.
function HostRow({ host, pattern }: { host: string; pattern?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <code className="font-mono text-sm text-foreground">{host}</code>
      {pattern ? (
        <span className="text-xs text-muted-foreground">(replace &lt;label&gt;)</span>
      ) : (
        <span className="relative z-10">
          <CopyButton value={host} />
        </span>
      )}
    </div>
  )
}
