"use client"

import { useEffect } from "react"
import { cn } from "@/lib/utils/cn"
import { useRdns, lookupRdns, type AggRow, type RdnsEntry } from "@/lib/cluster/netstatd"

type Props = {
  rows: AggRow[]
}

export default function ExternalList({ rows }: Props) {
  useEffect(() => {
    for (const row of rows) lookupRdns(row.label)
  }, [rows])

  return (
    <ul className="divide-y divide-gray-100">
      {rows.map(row => (
        <ExternalRow key={row.key} row={row} />
      ))}
    </ul>
  )
}

function ExternalRow({ row }: { row: AggRow }) {
  const entry = useRdns(s => s.cache.get(row.label))
  const { hostname, sub } = labelFor(row.label, entry)

  return (
    <li className="flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-gray-50">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm text-foreground">{hostname}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground/70">
          {sub ?? " "}
        </p>
      </div>
      <span className="font-mono text-xs text-muted-foreground">
        :{row.port} {row.protocol}
      </span>
      <span
        className={cn(
          "shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted-foreground",
          row.count >= 10 && "bg-brand-bg text-brand-label",
        )}
      >
        ×{row.count}
      </span>
    </li>
  )
}

function labelFor(
  ip: string,
  entry: RdnsEntry | undefined,
): { hostname: string; sub: string | null } {
  if (!entry || entry.status === "loading") return { hostname: ip, sub: "resolving…" }
  if (entry.status === "private") return { hostname: ip, sub: null }
  if (entry.hostname) return { hostname: entry.hostname, sub: ip }
  return { hostname: ip, sub: null }
}
