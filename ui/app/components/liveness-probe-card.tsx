import { AlertTriangle } from "lucide-react"
import type { LivenessProbe } from "@/lib/cluster/cluster-state"

export const LIVENESS_GUIDANCE =
  "Don't add liveness just because \"Kubernetes best practices say every pod needs health checks.\" Add it only when you can identify a failure mode where (1) the process stays alive, (2) it cannot recover itself, and (3) restarting it is actually the correct remediation."

export function LivenessBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-xs font-medium text-status-minor-label">
      <AlertTriangle className="size-3" aria-hidden />
      {label}
    </span>
  )
}

export default function LivenessProbeCard({ probes: all }: { probes: LivenessProbe[] }) {
  const probes = [...new Map(all.map(probe => [`${probe.container}::${probe.check}`, probe])).values()]
  if (probes.length === 0) return null

  return (
    <section aria-label="Liveness probe">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Liveness probe</p>
        <LivenessBadge label={String(probes.length)} />
      </div>
      <div className="rounded-xl border border-gray-200 bg-white">
        {probes.map(probe => (
          <div
            key={`${probe.container}::${probe.check}`}
            className="grid grid-cols-1 items-center gap-x-4 gap-y-1 border-b border-gray-100 px-5 py-3 md:grid-cols-[minmax(10rem,1fr)_2fr_auto]"
          >
            <span className="truncate font-mono text-sm font-medium text-foreground">{probe.container}</span>
            <span className="min-w-0 break-words font-mono text-xs text-muted-foreground">{probe.check}</span>
            <LivenessBadge label="Restarts on failure" />
          </div>
        ))}
        <p className="px-5 py-4 text-sm text-muted-foreground">{LIVENESS_GUIDANCE}</p>
      </div>
    </section>
  )
}
