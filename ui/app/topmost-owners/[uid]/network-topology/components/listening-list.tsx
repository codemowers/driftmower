"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ListeningGroup } from "@/lib/features/netstatd"

type Props = {
  groups: ListeningGroup[]
}

export default function ListeningList({ groups }: Props) {
  return (
    <ul className="divide-y divide-gray-100">
      {groups.map(group => (
        <ListeningGroupRow key={group.key} group={group} />
      ))}
    </ul>
  )
}

function ListeningGroupRow({ group }: { group: ListeningGroup }) {
  const [expanded, setExpanded] = useState(false)
  const addrCount = group.addresses.length
  const v4 = group.addresses.filter(a => !a.ip.includes(":")).length
  const v6 = addrCount - v4

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="font-mono text-sm text-foreground">:{group.port}</span>
        <span className="font-mono text-xs text-muted-foreground">{group.protocol}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {addrCount} {addrCount === 1 ? "addr" : "addrs"}
          {v4 > 0 && v6 > 0 && (
            <span className="ml-1 text-muted-foreground/60">({v4} v4, {v6} v6)</span>
          )}
        </span>
      </button>
      {expanded && (
        <ul className="divide-y divide-gray-100 border-t border-gray-100 bg-gray-50/40">
          {group.addresses.map(addr => (
            <li
              key={addr.key}
              className="flex items-center gap-4 px-4 py-2 pl-11"
            >
              <span className="truncate font-mono text-xs text-foreground">{addr.ip}</span>
              {addr.nodeName && (
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">
                  {addr.nodeName}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
