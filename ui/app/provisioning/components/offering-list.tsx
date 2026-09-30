"use client"

import { ExternalLink } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import { pickStorageClass, sampleFor } from "@/lib/features/provisioning/catalog/samples"
import { cn } from "@/lib/utils/cn"
import type { Availability, NamespaceFact, OfferingCard, StorageClassFact, Verdict } from "@/lib/features/provisioning/types"

const BADGE: Record<Availability["state"], { label: string; className: string }> = {
  ready: { label: "Ready", className: "bg-status-ok-bg text-status-ok-label" },
  // Both silent states get the same warning colour: in either one an apply
  // succeeds and nothing ever acts on the object.
  degraded: { label: "Controller down", className: "bg-status-minor-bg text-status-minor-label" },
  "crds-only": { label: "No controller", className: "bg-status-minor-bg text-status-minor-label" },
  "not-installed": { label: "Not installed", className: "bg-status-neutral-bg text-status-neutral-label" },
}

// Asked of the cluster authorizer as you, with enforced admission policies
// applied, by driftmower-mcp. "Not checked" is not "no": the review could not
// be evaluated, or the cluster does not serve the kind yet.
const VERDICT: Record<Verdict, { label: string; className: string }> = {
  yes: { label: "You can create this", className: "text-status-ok-label" },
  no: { label: "You cannot create this", className: "text-status-major-label" },
  unknown: { label: "Permission not checked", className: "text-muted-foreground" },
}

export default function OfferingList({
  offerings,
  storageClasses,
  namespace,
  sandboxId,
  verdicts,
}: {
  offerings: OfferingCard[]
  storageClasses: StorageClassFact[]
  // The selected namespace's per-offering verdicts; null when none is selected.
  verdicts: NamespaceFact["offerings"] | null
  // The selected sandbox's namespace, or null when none is selected — the
  // sample then carries no namespace line and lands wherever kubectl points.
  namespace: string | null
  // Its codemowers.io/sandbox id, for samples that name things beyond it.
  sandboxId: string | null
}) {
  if (offerings.length === 0) {
    return <p className="text-sm text-muted-foreground">No offerings are known to this build.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {offerings.map(card => (
        <OfferingRow
          key={card.id}
          card={card}
          namespace={namespace}
          sandboxId={sandboxId}
          storageClass={pickStorageClass(card.id, storageClasses)}
          verdict={verdicts?.[card.id] ?? null}
        />
      ))}
    </div>
  )
}

function OfferingRow({
  card,
  namespace,
  sandboxId,
  storageClass,
  verdict,
}: {
  card: OfferingCard
  namespace: string | null
  sandboxId: string | null
  storageClass: string | null
  verdict: { verdict: Verdict; reason: string } | null
}) {
  const badge = BADGE[card.availability.state]
  // A sample is only honest when the cluster serves the kind: apiVersion is the
  // version discovery negotiated, and it is null exactly when it does not.
  const sample = card.apiVersion ? sampleFor(card.id, { apiVersion: card.apiVersion, namespace, sandboxId, storageClass }) : null

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-heading text-sm font-semibold text-foreground">{card.name}</h3>
        <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", badge.className)}>{badge.label}</span>
        {card.operator && (
          <a
            href={card.operator.docsHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            via {card.operator.name}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
        {card.resource && (
          <code className="ml-auto font-mono text-xs text-muted-foreground">
            {card.resource}
            {card.apiVersion ? ` · ${card.apiVersion.split("/")[1]}` : ""}
          </code>
        )}
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{card.what}</p>

      {verdict && namespace && (
        <p className="mt-2 text-sm">
          <span className={cn("font-medium", VERDICT[verdict.verdict].className)}>
            {VERDICT[verdict.verdict].label} in {namespace}.
          </span>{" "}
          <span className="text-muted-foreground">{verdict.reason}</span>
        </p>
      )}

      {sample ? (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              The smallest manifest that gets you one{namespace ? ` in ${namespace}` : ""}:
            </span>
            <span className="relative z-10">
              <CopyButton value={sample.yaml} />
            </span>
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {sample.yaml}
          </pre>

          <p className="text-sm text-muted-foreground">{sample.creates}</p>

          {/* A command, never the value: this app has no business reading the
              Secret it points at. */}
          {sample.connect && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
              <code className="overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
                {sample.connect}
              </code>
              <span className="relative z-10 shrink-0">
                <CopyButton value={sample.connect} />
              </span>
            </div>
          )}

          {/* The apply would succeed in both silent states, so the warning
              belongs beside the sample rather than instead of it. */}
          {(card.availability.state === "crds-only" || card.availability.state === "degraded") && (
            <p className="text-sm text-status-minor-label">{card.availability.reason}</p>
          )}
        </div>
      ) : (
        // Never a dead end: what it would take to have this here.
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">This cluster does not serve the kind. It would need:</p>
          <ul className="flex flex-col gap-1">
            {card.needs.map(need => (
              <li key={need} className="text-sm text-muted-foreground">
                &mdash; {need}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
