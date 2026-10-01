"use client"

import { useNetstatd, useNetstatdMissing, filterListening } from "@/lib/features/netstatd"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

type Props = {
  pod: ClusterResource
}

export default function PortsTab({ pod }: Props) {
  const listening = useNetstatd(s => s.listening)
  const missing = useNetstatdMissing()
  const rows = filterListening(listening, new Set([pod.uid]))
  const declared = [...(pod.declaredPorts ?? [])].sort((a, b) => a.port - b.port)

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Declared
        </h3>
        {declared.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
            <p className="text-sm text-muted-foreground">No declared ports.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="grid grid-cols-[3.5rem_1fr_1fr_4.5rem] gap-4 border-b border-gray-100 bg-gray-50 px-4 py-2">
              <p className="text-xs font-medium text-muted-foreground">Port</p>
              <p className="text-xs font-medium text-muted-foreground">Name</p>
              <p className="text-xs font-medium text-muted-foreground">Container</p>
              <p className="text-right text-xs font-medium text-muted-foreground">Protocol</p>
            </div>
            <ul className="divide-y divide-gray-100">
              {declared.map(p => (
                <li
                  key={`${p.container}:${p.port}:${p.protocol}`}
                  className="grid grid-cols-[3.5rem_1fr_1fr_4.5rem] items-center gap-4 px-4 py-2.5"
                >
                  <span className="font-mono text-sm text-foreground tabular-nums">:{p.port}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{p.name ?? "—"}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={p.container}>
                    {p.container}
                  </span>
                  <span className="text-right font-mono text-xs text-muted-foreground">{p.protocol}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {!missing && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Listening
          </h3>
          {rows.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
              <p className="text-sm text-muted-foreground">
                No listening ports observed.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="grid grid-cols-[3.5rem_1fr_4.5rem] gap-4 border-b border-gray-100 bg-gray-50 px-4 py-2">
                <p className="text-xs font-medium text-muted-foreground">Port</p>
                <p className="text-xs font-medium text-muted-foreground">Address</p>
                <p className="text-right text-xs font-medium text-muted-foreground">Protocol</p>
              </div>
              <ul className="divide-y divide-gray-100">
                {rows.map(p => (
                  <li
                    key={p.key}
                    className="grid grid-cols-[3.5rem_1fr_4.5rem] items-center gap-4 px-4 py-2.5"
                  >
                    <span className="font-mono text-sm text-foreground tabular-nums">:{p.port}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground" title={p.ip}>
                      {p.ip}
                    </span>
                    <span className="text-right font-mono text-xs text-muted-foreground">{p.protocol}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
