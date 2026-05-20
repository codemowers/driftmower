"use client"

import { useNetstatd, filterListening } from "@/lib/cluster/netstatd"
import type { ExplorerResource } from "@/lib/cluster/cluster-state"

type Props = {
  pod: ExplorerResource
}

export default function PortsTab({ pod }: Props) {
  const listening = useNetstatd(s => s.listening)
  const podIPs = new Set(pod.ips ?? [])
  const rows = filterListening(listening, podIPs)

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Declared
        </h3>
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-5 py-4">
          <p className="text-sm text-muted-foreground">Declared ports unavailable.</p>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Listening
        </h3>
        {podIPs.size === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
            <p className="text-sm text-muted-foreground">Pod has no IP yet.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
            <p className="text-sm text-muted-foreground">
              No listening ports observed.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="grid grid-cols-[auto_1fr_auto] gap-4 border-b border-gray-100 bg-gray-50 px-4 py-2">
              <p className="text-xs font-medium text-muted-foreground">Port</p>
              <p className="text-xs font-medium text-muted-foreground">Address</p>
              <p className="text-xs font-medium text-muted-foreground">Protocol</p>
            </div>
            <ul className="divide-y divide-gray-100">
              {rows.map(p => (
                <li
                  key={p.key}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-2.5"
                >
                  <span className="font-mono text-sm text-foreground tabular-nums">:{p.port}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={p.ip}>
                    {p.ip}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{p.protocol}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}
