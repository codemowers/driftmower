"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils/cn"

export type TocEntry = { id: string; title: string }

// Section list for the provisioning page. Renders as a sticky left rail on
// wide screens and as a wrapping row of links above the content otherwise.
// The entry whose heading is nearest the top of the scroll container is
// highlighted; the page scrolls inside a layout div rather than the window,
// so the observer is rooted on the nearest scrolling ancestor.
export default function TableOfContents({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = useState<string | null>(entries[0]?.id ?? null)

  useEffect(() => {
    const targets = entries.map(e => document.getElementById(e.id)).filter((el): el is HTMLElement => el !== null)
    if (targets.length === 0) return

    const root = scrollParent(targets[0])
    const visible = new Map<string, number>()

    const observer = new IntersectionObserver(
      records => {
        for (const r of records) {
          if (r.isIntersecting) visible.set(r.target.id, r.boundingClientRect.top)
          else visible.delete(r.target.id)
        }
        if (visible.size === 0) return
        // Topmost visible heading wins, in document order.
        const next = entries.find(e => visible.has(e.id))
        if (next) setActive(next.id)
      },
      { root, rootMargin: "0px 0px -60% 0px", threshold: 0 },
    )
    targets.forEach(t => observer.observe(t))
    return () => observer.disconnect()
  }, [entries])

  if (entries.length === 0) return null

  return (
    <nav aria-label="On this page" className="xl:sticky xl:top-6 xl:self-start">
      <p className="mb-2 hidden text-xs font-semibold uppercase tracking-wider text-muted-foreground xl:block">
        On this page
      </p>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 xl:flex-col xl:gap-y-0 xl:border-l xl:border-border">
        {entries.map(e => {
          const isActive = e.id === active
          return (
            <li key={e.id}>
              <a
                href={`#${e.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={() => setActive(e.id)}
                className={cn(
                  "block text-sm transition-colors xl:-ml-px xl:border-l xl:py-1 xl:pl-3",
                  isActive
                    ? "text-foreground xl:border-foreground"
                    : "text-muted-foreground hover:text-foreground xl:border-transparent",
                )}
              >
                {e.title}
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
  }
  return null
}
